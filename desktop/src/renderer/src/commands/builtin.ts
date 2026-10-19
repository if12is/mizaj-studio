import { EXPORT_FORMATS } from '@renderer/files/formats'
import { useEditorStore } from '@renderer/stores/editor'
import { useFileStore } from '@renderer/stores/fileio'
import { useGeminiStore } from '@renderer/stores/gemini'
import { usePaletteStore } from '@renderer/stores/palette'
import { useProjectsStore } from '@renderer/stores/projects'
import { useQualityStore } from '@renderer/stores/quality'
import { useSettingsStore } from '@renderer/stores/settings'
import { registerCommands, type Command } from './registry'

/** Per-document actions owned by the editor pane (the toolbar buttons call the same ones). */
export interface EditorActions {
  tashkeel(): void | Promise<void>
  proofreadThenTashkeel(): void | Promise<void>
  paragraphRun(): void | Promise<void>
  spellCheck(): void | Promise<void>
  togglePageView(): void
  toggleReview(): void
  exportDocx(): void | Promise<void>
  toggleTts(): void
  focus(): void
}

/** What the built-in commands need from the app shell (App.vue supplies it). */
export interface BuiltinContext {
  editorActions: () => EditorActions | undefined
  newTab(): void
  closeActiveTab(): void
  nextTab(): void
  prevTab(): void
}

const G = {
  tabs: 'التبويبات',
  file: 'ملف',
  edit: 'التحرير',
  view: 'عرض',
  panels: 'اللوحات',
  app: 'التطبيق'
}

/**
 * Registers every built-in app command / menu action. To add a command anywhere in the app, call
 * registerCommand() from './registry': the palette picks it up with no further change.
 * `shortcut` = display text; `global` + `keybinding` = also bound app-wide by the key handler.
 */
export function registerBuiltinCommands(ctx: BuiltinContext): () => void {
  const editor = useEditorStore()
  const files = useFileStore()
  const gemini = useGeminiStore()
  const palette = usePaletteStore()
  const projects = useProjectsStore()
  const quality = useQualityStore()
  const settings = useSettingsStore()
  const hasDoc = (): boolean => !!projects.currentDocument
  const act = (): EditorActions | undefined => ctx.editorActions()
  const panel = (id: 'spelling' | 'legal' | 'poetry' | 'quality' | 'gemini'): void => {
    editor.rightPanel = editor.rightPanel === id ? null : id
  }

  const list: Command[] = [
    {
      id: 'palette.open',
      title: 'البحث الشامل ولوحة الأوامر',
      shortcut: 'Ctrl+K',
      keybinding: ['Mod+K', 'Mod+Shift+P'],
      global: true,
      hidden: true,
      run: () => palette.toggle()
    },
    // ---------------------------------------------------------------- tabs
    {
      id: 'tabs.new',
      title: 'تبويب جديد',
      group: G.tabs,
      keywords: ['new tab'],
      shortcut: 'Ctrl+T',
      keybinding: 'Mod+T',
      global: true,
      run: () => ctx.newTab()
    },
    {
      id: 'tabs.close',
      title: 'إغلاق التبويب الحالي',
      group: G.tabs,
      keywords: ['close tab'],
      shortcut: 'Ctrl+W',
      keybinding: 'Mod+W',
      global: true,
      run: () => ctx.closeActiveTab()
    },
    {
      id: 'tabs.next',
      title: 'التبويب التالي',
      group: G.tabs,
      shortcut: 'Ctrl+Tab',
      keybinding: 'Ctrl+Tab',
      global: true,
      run: () => ctx.nextTab()
    },
    {
      id: 'tabs.prev',
      title: 'التبويب السابق',
      group: G.tabs,
      shortcut: 'Ctrl+Shift+Tab',
      keybinding: 'Ctrl+Shift+Tab',
      global: true,
      run: () => ctx.prevTab()
    },
    // ---------------------------------------------------------------- file
    {
      id: 'file.import',
      title: 'استيراد ملف…',
      group: G.file,
      keywords: ['import', 'docx', 'pdf'],
      run: () => void files.importFile()
    },
    ...EXPORT_FORMATS.map<Command>((f) => ({
      id: `file.export.${f.id}`,
      title: `تصدير المستند الحالي: ${f.label}`,
      group: G.file,
      keywords: ['export', 'save as', f.id],
      enabled: () => hasDoc() && !files.busy,
      run: () => void files.exportAs(f.id)
    })),
    {
      id: 'file.batch',
      title: 'معالجة مجلد…',
      group: G.file,
      keywords: ['batch', 'folder'],
      run: () => (files.batchOpen = true)
    },
    // ---------------------------------------------------------------- editing
    {
      id: 'edit.tashkeel',
      title: 'تشكيل المحدد أو كامل المقال',
      group: G.edit,
      keywords: ['tashkeel', 'diacritize', 'تشكيل'],
      shortcut: 'Ctrl+Shift+T',
      enabled: hasDoc,
      run: () => act()?.tashkeel()
    },
    {
      id: 'edit.proofread',
      title: 'تدقيق ثم تشكيل',
      group: G.edit,
      keywords: ['proofread'],
      enabled: hasDoc,
      run: () => act()?.proofreadThenTashkeel()
    },
    {
      id: 'edit.paragraph',
      title: 'تشكيل الفقرة الحالية مع مراجعة',
      group: G.edit,
      shortcut: 'Ctrl+Alt+T',
      enabled: hasDoc,
      run: () => act()?.paragraphRun()
    },
    {
      id: 'edit.find',
      title: 'بحث واستبدال',
      group: G.edit,
      keywords: ['find', 'replace', 'search'],
      shortcut: 'Ctrl+F',
      run: () => (editor.findOpen = true)
    },
    {
      id: 'edit.spell',
      title: 'تدقيق إملائي كامل',
      group: G.edit,
      keywords: ['spelling', 'spell check'],
      shortcut: 'Ctrl+Shift+L',
      enabled: hasDoc,
      run: () => act()?.spellCheck()
    },
    {
      id: 'edit.review',
      title: 'وضع المراجعة (الكلمات منخفضة الثقة)',
      group: G.edit,
      keywords: ['review', 'confidence'],
      shortcut: 'F7',
      enabled: hasDoc,
      run: () => act()?.toggleReview()
    },
    {
      id: 'edit.normalize',
      title: 'توحيد النص',
      group: G.edit,
      keywords: ['normalize'],
      enabled: hasDoc,
      run: () => (quality.normalizeOpen = true)
    },
    {
      id: 'edit.poetry',
      title: 'تبديل وضع الشعر',
      group: G.edit,
      keywords: ['poetry', 'شعر'],
      enabled: hasDoc,
      run: () => void quality.setPoetry(!quality.poetryOn)
    },
    {
      id: 'edit.tts',
      title: 'قراءة بصوت عالٍ / إيقاف القراءة',
      group: G.edit,
      keywords: ['tts', 'read aloud'],
      enabled: hasDoc,
      run: () => act()?.toggleTts()
    },
    // ---------------------------------------------------------------- view
    {
      id: 'view.pageView',
      title: 'تبديل عرض الصفحة',
      group: G.view,
      keywords: ['page view', 'preview'],
      enabled: hasDoc,
      run: () => act()?.togglePageView()
    },
    {
      id: 'view.diff',
      title: 'مقارنة قبل/بعد التشكيل',
      group: G.view,
      keywords: ['diff', 'compare'],
      enabled: () => editor.diffBase !== null,
      run: () => (editor.showDiff = !editor.showDiff)
    },
    {
      id: 'view.stats',
      title: 'إحصائيات المستند',
      group: G.view,
      keywords: ['stats', 'statistics'],
      run: () => (editor.showStats = !editor.showStats)
    },
    {
      id: 'view.zoomIn',
      title: 'تكبير الخط',
      group: G.view,
      keywords: ['zoom in'],
      shortcut: 'Ctrl+=',
      run: () => void settings.zoom('in')
    },
    {
      id: 'view.zoomOut',
      title: 'تصغير الخط',
      group: G.view,
      keywords: ['zoom out'],
      shortcut: 'Ctrl+-',
      run: () => void settings.zoom('out')
    },
    {
      id: 'view.zoomReset',
      title: 'إعادة حجم الخط',
      group: G.view,
      shortcut: 'Ctrl+0',
      run: () => void settings.zoom('reset')
    },
    {
      id: 'view.theme',
      title: 'تبديل السمة (فاتح / داكن)',
      group: G.view,
      keywords: ['theme', 'dark', 'light'],
      run: () =>
        void settings.update({ theme: settings.values.theme === 'light' ? 'dark' : 'light' })
    },
    // ---------------------------------------------------------------- panels
    {
      id: 'panel.spelling',
      title: 'لوحة قائمة الأخطاء الإملائية',
      group: G.panels,
      run: () => panel('spelling')
    },
    {
      id: 'panel.legal',
      title: 'لوحة الأدوات القانونية',
      group: G.panels,
      keywords: ['legal'],
      run: () => panel('legal')
    },
    {
      id: 'panel.poetry',
      title: 'لوحة تحليل البحر',
      group: G.panels,
      keywords: ['poetry', 'meter'],
      run: () => panel('poetry')
    },
    {
      id: 'panel.quality',
      title: 'لوحة جودة التحرير',
      group: G.panels,
      keywords: ['quality'],
      run: () => panel('quality')
    },
    {
      id: 'panel.gemini',
      title: 'اسأل Gemini عن المستند',
      group: G.panels,
      keywords: ['gemini', 'ai', 'ask'],
      enabled: () => gemini.enabled,
      run: () => panel('gemini')
    },
    // ---------------------------------------------------------------- app
    {
      id: 'app.settings',
      title: 'فتح الإعدادات',
      group: G.app,
      keywords: ['settings', 'preferences'],
      run: () => settings.openSettings()
    },
    {
      id: 'app.shortcuts',
      title: 'اختصارات لوحة المفاتيح',
      group: G.app,
      keywords: ['shortcuts', 'keyboard', 'help'],
      shortcut: 'Ctrl+/',
      run: () => (editor.shortcutsOpen = true)
    },
    {
      id: 'app.guide.quick',
      title: 'الدليل السريع',
      group: G.app,
      keywords: ['guide', 'help', 'دليل', 'مساعدة', 'شرح'],
      shortcut: 'F1',
      global: true,
      keybinding: 'F1',
      run: () => window.mizajAPI?.openGuide('quick')
    },
    {
      id: 'app.guide.full',
      title: 'الدليل الكامل',
      group: G.app,
      keywords: ['guide', 'manual', 'دليل', 'مساعدة'],
      run: () => window.mizajAPI?.openGuide('guide')
    },
    {
      id: 'app.about',
      title: 'عن مِزَاج',
      group: G.app,
      keywords: ['about', 'version'],
      run: () => (editor.aboutOpen = true)
    }
  ]
  return registerCommands(list)
}
