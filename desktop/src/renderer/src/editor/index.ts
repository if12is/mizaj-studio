import { Prec, type Extension } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import { mizajKeymap, redoShiftZ } from './commands'
import { inspectorExtension, type InspectorConfig } from './inspector'
import { spellingExtension, type SpellConfig } from './spelling'
import { findExtension, type FindConfig } from './find'
import { pendingExtension, type PendingConfig } from './pending'

export interface MizajEditorConfig {
  inspector: InspectorConfig
  spelling: SpellConfig
  find: FindConfig
  pending: PendingConfig
  onParagraphRun: () => void
  onDiacritize: () => void
}

export function mizajEditorExtensions(cfg: MizajEditorConfig): Extension[] {
  return [
    Prec.highest(redoShiftZ),
    Prec.high(keymap.of(mizajKeymap(cfg.onDiacritize))),
    inspectorExtension(cfg.inspector),
    spellingExtension(cfg.spelling),
    findExtension(cfg.find),
    pendingExtension(cfg.pending),
    Prec.high(
      keymap.of([
        {
          key: 'Mod-Alt-t',
          preventDefault: true,
          run: () => {
            cfg.onParagraphRun()
            return true
          }
        }
      ])
    )
  ]
}
