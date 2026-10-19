import { useExtrasStore } from '@renderer/stores/extras'
import { useProjectsStore } from '@renderer/stores/projects'
import { registerCommands, type Command } from './registry'

/**
 * Commands of the lazily loaded extras: search across all files, printing / PDF, the guided tour.
 * Registered next to the built-in commands (App.vue), so the palette and the key handler see them.
 */
export function registerExtraCommands(): () => void {
  const extras = useExtrasStore()
  const projects = useProjectsStore()
  const hasDoc = (): boolean => !!projects.currentDocument
  const list: Command[] = [
    {
      id: 'search.global',
      title: 'بحث في كل الملفات',
      group: 'التحرير',
      keywords: ['search', 'find in files', 'full text', 'محتوى', 'بحث شامل'],
      shortcut: 'Ctrl+Shift+F',
      keybinding: 'Mod+Shift+F',
      global: true,
      run: () => extras.openSearch()
    },
    {
      id: 'file.print',
      title: 'طباعة المستند الحالي…',
      group: 'ملف',
      keywords: ['print', 'preview', 'معاينة'],
      shortcut: 'Ctrl+P',
      keybinding: 'Mod+P',
      global: true,
      enabled: hasDoc,
      run: () => (extras.printOpen = true)
    },
    {
      id: 'file.pdf',
      title: 'حفظ المستند بصيغة PDF…',
      group: 'ملف',
      keywords: ['pdf', 'save as pdf'],
      enabled: hasDoc,
      run: () => (extras.printOpen = true)
    },
    {
      id: 'app.tour',
      title: 'جولة تعريفية',
      group: 'التطبيق',
      keywords: ['tour', 'onboarding', 'intro', 'جولة', 'شرح', 'مساعدة'],
      run: () => (extras.tourActive = true)
    }
  ]
  return registerCommands(list)
}
