import { describe, expect, it } from 'vitest'
import { ApiError } from '@renderer/api/client'
import {
  baseName,
  confidenceLevel,
  exportErrorMessage,
  exportFileName,
  extOf,
  importKind,
  ocrErrorMessage,
  stem
} from './formats'

describe('file format helpers', () => {
  it('classifies imports by extension', () => {
    expect(importKind('C:\\x\\a.DOCX')).toBe('docx')
    expect(importKind('/a/b.pdf')).toBe('pdf')
    expect(importKind('/a/b.JPG')).toBe('image')
    expect(importKind('/a/b.srt')).toBe('text')
    expect(importKind('/a/b.exe')).toBe('unsupported')
    expect(importKind('/a/noext')).toBe('unsupported')
  })
  it('splits paths', () => {
    expect(baseName('C:\\x\\a.docx')).toBe('a.docx')
    expect(stem('/a/b/c.d.txt')).toBe('c.d')
    expect(extOf('/a.TXT')).toBe('txt')
  })
  it('builds a safe export name', () => {
    expect(exportFileName('عقد: إيجار/1', 'txt')).toBe('عقد_ إيجار_1.txt')
    expect(exportFileName(undefined, 'pdf')).toBe('mizaj.pdf')
  })
  it('bands OCR confidence', () => {
    expect(confidenceLevel(92)).toBe('high')
    expect(confidenceLevel(70)).toBe('medium')
    expect(confidenceLevel(30)).toBe('low')
    expect(confidenceLevel(null)).toBe('none')
  })
  it('explains missing Tesseract with the install hint', () => {
    const e = new ApiError(424, 'ERR_OCR_TESSERACT_MISSING', 'x', 'y', {
      hint: 'apt install tesseract-ocr'
    })
    const m = ocrErrorMessage(e)
    expect(m.missing).toBe(true)
    expect(m.text).toContain('Tesseract')
    expect(m.hint).toBe('apt install tesseract-ocr')
    expect(ocrErrorMessage(new ApiError(500, 'ERR_OCR_FAILED', 'فشل', '')).missing).toBe(false)
  })
  it('explains a locked output file', () => {
    expect(exportErrorMessage(new ApiError(423, 'ERR_DOCX_WRITE_LOCKED', 'q', ''))).toContain(
      'مفتوح'
    )
  })
})
