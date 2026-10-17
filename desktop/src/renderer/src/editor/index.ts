import { Prec, type Extension } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import { mizajKeymap, redoShiftZ } from './commands'
import { inspectorExtension, type InspectorConfig } from './inspector'

export interface MizajEditorConfig {
  inspector: InspectorConfig
  onDiacritize: () => void
}

export function mizajEditorExtensions(cfg: MizajEditorConfig): Extension[] {
  return [
    Prec.highest(redoShiftZ),
    Prec.high(keymap.of(mizajKeymap(cfg.onDiacritize))),
    inspectorExtension(cfg.inspector)
  ]
}
