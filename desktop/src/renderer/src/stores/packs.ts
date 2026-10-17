import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useApi } from '@renderer/api'
import { notify } from '@renderer/api/toast'
import { ApiError } from '@renderer/api/client'
import { pickOpenPath, pickSavePath } from '@renderer/lib/native'
import { appliedText, buildDecisions, type Choice, type PlanGroups } from '@renderer/packs/labels'

export interface ExportForm {
  kinds: string[]
  name: string
  version: string
  license: string
  author: string
  attribution: string
  description: string
  include_sample_templates: boolean
  include_private_settings: boolean
}

export interface PackPreview {
  name: string
  version: string | null
  kinds: string[]
  license: string | null
  attribution: string
  author: string
  description: string
  content_sha256: string | null
  models: { files: number } | null
  summary: Record<string, { adds: number; updates: number; conflicts: number; skips: number }>
  items: Record<string, PlanGroups>
}

export interface ImportRecord {
  id: string
  kind: string
  name: string
  version: string | null
  status: string
  created_at: string
  undone_at: string | null
  summary: unknown
}

export interface BackupInfo {
  kind?: string
  created_at?: string
  app_version?: string
  includes_models?: boolean
  files: number
  restorable: boolean
}

export function packErrorText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.errorCode === 'ERR_PACK_INVALID') return `ملف الحزمة غير صالح: ${e.messageAr}`
    return e.messageAr
  }
  return 'تعذرت العملية.'
}

export const usePacksStore = defineStore('packs', () => {
  const busy = ref(false)
  const message = ref<{ ok: boolean; text: string } | null>(null)
  const backupMessage = ref<{ ok: boolean; text: string } | null>(null)
  const preview = ref<PackPreview | null>(null)
  const previewPath = ref('')
  const selectedKinds = ref<string[]>([])
  const choices = ref<Record<string, Record<string, Choice>>>({})
  const history = ref<ImportRecord[]>([])

  async function loadHistory(): Promise<void> {
    try {
      history.value = await useApi().get<ImportRecord[]>('/api/packs/v2/imports', true)
    } catch {
      history.value = []
    }
  }

  async function exportPack(form: ExportForm): Promise<void> {
    if (!form.license.trim()) {
      message.value = { ok: false, text: 'الترخيص مطلوب لتصدير الحزمة.' }
      return
    }
    if (!form.name.trim()) {
      message.value = { ok: false, text: 'اسم الحزمة مطلوب.' }
      return
    }
    if (!form.kinds.length) {
      message.value = { ok: false, text: 'اختر نوعاً واحداً على الأقل للتصدير.' }
      return
    }
    const target = await pickSavePath(
      `${form.name.trim() || 'mizaj'}.mizajpack`,
      ['mizajpack'],
      'Mizaj pack'
    )
    if (!target) return
    busy.value = true
    message.value = null
    try {
      const r = await useApi().request<{ entries?: Record<string, number> }>(
        'POST',
        '/api/packs/v2/export',
        { ...form, target_path: target },
        true
      )
      message.value = { ok: true, text: `تم تصدير الحزمة: ${target}` }
      void r
    } catch (e) {
      message.value = { ok: false, text: packErrorText(e) }
    } finally {
      busy.value = false
    }
  }

  async function chooseAndPreview(): Promise<void> {
    const path = await pickOpenPath(['mizajpack'], 'Mizaj pack')
    if (!path) return
    await previewFile(path)
  }

  async function previewFile(path: string): Promise<void> {
    busy.value = true
    message.value = null
    try {
      const p = await useApi().request<PackPreview>('POST', '/api/packs/v2/preview', { path }, true)
      preview.value = p
      previewPath.value = path
      selectedKinds.value = [...p.kinds]
      choices.value = {}
    } catch (e) {
      preview.value = null
      message.value = { ok: false, text: packErrorText(e) }
    } finally {
      busy.value = false
    }
  }

  function setChoice(kind: string, key: string, c: Choice): void {
    choices.value = { ...choices.value, [kind]: { ...(choices.value[kind] ?? {}), [key]: c } }
  }

  function cancelPreview(): void {
    preview.value = null
  }

  async function apply(): Promise<void> {
    const p = preview.value
    if (!p) return
    busy.value = true
    try {
      const kinds = selectedKinds.value
      const plans: Record<string, PlanGroups> = {}
      for (const k of kinds) if (p.items[k]) plans[k] = p.items[k]
      const r = await useApi().request<{
        import_id: string | null
        applied: Record<string, { added: number; updated: number; kept_local: number }>
        undoable: boolean
        models: { version: string } | null
      }>(
        'POST',
        '/api/packs/v2/apply',
        {
          path: previewPath.value,
          kinds,
          decisions: buildDecisions(plans, choices.value),
          expected_content_sha256: p.content_sha256
        },
        true
      )
      const parts = [appliedText(r.applied)]
      if (r.models) parts.push(`تم تحديث النماذج (الإصدار ${r.models.version}).`)
      message.value = { ok: true, text: `تم الاستيراد. ${parts.filter(Boolean).join(' ')}` }
      preview.value = null
      await loadHistory()
    } catch (e) {
      message.value = { ok: false, text: packErrorText(e) }
    } finally {
      busy.value = false
    }
  }

  async function undo(id: string): Promise<void> {
    busy.value = true
    try {
      const r = await useApi().request<{ reverted: number; skipped_modified_since: number }>(
        'POST',
        `/api/packs/v2/undo/${id}`,
        {},
        true
      )
      message.value = {
        ok: true,
        text: `تم التراجع: أُعيد ${r.reverted} عنصراً${r.skipped_modified_since ? `، وتُرك ${r.skipped_modified_since} لأنك عدّلته بعد الاستيراد` : ''}.`
      }
      await loadHistory()
    } catch (e) {
      message.value = { ok: false, text: packErrorText(e) }
    } finally {
      busy.value = false
    }
  }

  // ---------------------------------------------------------- backup
  const backup = ref<{ path: string; info: BackupInfo } | null>(null)
  const restoreState = ref<'idle' | 'restored' | 'pending'>('idle')

  async function exportBackup(includeModels: boolean): Promise<void> {
    const stamp = new Date().toISOString().slice(0, 10)
    const target = await pickSavePath(
      `mizaj-backup-${stamp}.mizajbackup`,
      ['mizajbackup'],
      'Mizaj backup'
    )
    if (!target) return
    busy.value = true
    backupMessage.value = null
    try {
      await useApi().request(
        'POST',
        '/api/backup/export',
        { target_path: target, include_models: includeModels },
        true
      )
      backupMessage.value = { ok: true, text: `تم إنشاء النسخة الاحتياطية: ${target}` }
    } catch (e) {
      backupMessage.value = { ok: false, text: packErrorText(e) }
    } finally {
      busy.value = false
    }
  }

  async function chooseBackup(): Promise<void> {
    const path = await pickOpenPath(['mizajbackup'], 'Mizaj backup')
    if (!path) return
    busy.value = true
    backupMessage.value = null
    restoreState.value = 'idle'
    try {
      const info = await useApi().request<BackupInfo>('POST', '/api/backup/inspect', { path }, true)
      backup.value = { path, info }
    } catch (e) {
      backup.value = null
      backupMessage.value = { ok: false, text: packErrorText(e) }
    } finally {
      busy.value = false
    }
  }

  async function restore(): Promise<void> {
    const b = backup.value
    if (!b) return
    busy.value = true
    try {
      const r = await useApi().request<{ status: 'restored' | 'pending' }>(
        'POST',
        '/api/backup/restore',
        { path: b.path },
        true
      )
      restoreState.value = r.status === 'pending' ? 'pending' : 'restored'
      backupMessage.value = {
        ok: true,
        text:
          r.status === 'pending'
            ? 'سيتم الاستعادة عند إعادة التشغيل.'
            : 'تمت الاستعادة. أعد تشغيل التطبيق لتحميل البيانات المستعادة.'
      }
    } catch (e) {
      backupMessage.value = { ok: false, text: packErrorText(e) }
    } finally {
      busy.value = false
    }
  }

  function relaunch(): void {
    void window.mizajAPI
      ?.relaunchApp()
      .catch(() => notify('تعذرت إعادة التشغيل؛ أغلق التطبيق وافتحه يدوياً.'))
  }

  return {
    busy,
    message,
    backupMessage,
    preview,
    previewPath,
    selectedKinds,
    choices,
    history,
    backup,
    restoreState,
    loadHistory,
    exportPack,
    chooseAndPreview,
    previewFile,
    setChoice,
    cancelPreview,
    apply,
    undo,
    exportBackup,
    chooseBackup,
    restore,
    relaunch
  }
})
