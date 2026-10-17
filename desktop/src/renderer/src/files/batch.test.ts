import { describe, expect, it } from 'vitest'
import {
  batchPercent,
  describeBatchError,
  isFinished,
  validateBatchForm,
  type BatchForm
} from './batch'

const form: BatchForm = {
  input_dir: '/in',
  output_dir: '/out',
  mode: 'fast',
  level: 'full',
  formats: ['txt'],
  recursive: true,
  on_exist: 'rename',
  track_changes: false
}

describe('batch helpers', () => {
  it('computes percent', () => {
    expect(batchPercent({ total: 0, done: 0 })).toBe(100)
    expect(batchPercent({ total: 4, done: 1 })).toBe(25)
    expect(batchPercent({ total: 3, done: 9 })).toBe(100)
  })
  it('knows terminal states', () => {
    expect(isFinished('running')).toBe(false)
    expect(isFinished('cancelled')).toBe(true)
  })
  it('validates the form', () => {
    expect(validateBatchForm(form)).toBeNull()
    expect(validateBatchForm({ ...form, input_dir: '' })).toContain('الإدخال')
    expect(validateBatchForm({ ...form, output_dir: '/in' })).toContain('يختلف')
    expect(validateBatchForm({ ...form, formats: [] })).toContain('صيغة')
  })
  it('describes per-file errors', () => {
    expect(describeBatchError({ path: 'C:\\a\\b.docx', message_ar: 'تالف' })).toBe('b.docx: تالف')
    expect(describeBatchError({ path: '/a/b.txt', error_code: 'ERR_X' })).toBe('b.txt: ERR_X')
  })
})
