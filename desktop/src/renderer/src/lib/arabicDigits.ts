const INDIC = '٠١٢٣٤٥٦٧٨٩'

/** 12 -> «١٢» (Arabic-Indic digits, as printed on page numbers and relative times). */
export const toArabicIndic = (n: number | string): string =>
  String(n).replace(/[0-9]/g, (d) => INDIC[Number(d)])

/** «صفحة ١ من ٥» */
export const pageLabel = (page: number, total: number): string =>
  `صفحة ${toArabicIndic(page)} من ${toArabicIndic(total)}`
