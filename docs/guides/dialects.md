# Dialects and the tashkeel engine | اللهجات والتشكيل

## العربية

**الخلاصة:** محرك التشكيل في مزاج مُدرَّب على العربية الفصحى (الكلاسيكية والحديثة). النص العامي
(مصري، خليجي، شامي، مغاربي...) يُشكَّل أيضاً، لكن النتيجة **أقل موثوقية**، وقد تُفرَض عليه
حركات إعراب فصيحة لا ينطق بها المتكلم أصلاً.

**ماذا يفعل المحرك مع العامية؟**
- يعامل كل كلمة كأنها فصحى: كلمات مثل «عايز» و«دلوقتي» و«بتاع» و«هلق» لا توجد في معاجم الفصحى،
  فيخمّن النموذج العصبي (CATT) تشكيلاً قد يكون غير مقصود، ويعود المحرك السريع (mishkal) إلى
  تخمينات صرفية للفصحى.
- لا يغيّر حروف الكلمات أبداً: `strip_marks(output) == strip_marks(input)` يُطبَّق على كل المسارات،
  فيبقى النص العامي سليماً وتتغير الحركات فقط.
- درجات الثقة لكل كلمة (`confidence` في `/api/tashkeel`) تنخفض عادة في العامية، فيمكن للواجهة
  تلوين الكلمات الضعيفة للمراجعة.

**إشارة تحذيرية:** `POST /api/text/dialect-hint` بجسم `{"text": "..."}` يعيد
`{likely_dialectal, score, dialect, markers[]}`. هو تقدير بسيط بقوائم مغلقة من علامات اللهجات
(مثل: ده، دي، عايز، مش، إزاي للمصرية؛ وايد، شلون، شفيك للخليجية؛ هلق، شو، كتير للشامية).
- النتيجة السالبة لا تعني أن النص فصيح؛ القائمة قصيرة عمداً لتقليل الإنذارات الكاذبة.
- لا يُرسل النص إلى أي خدمة خارجية، ولا يغيّر شيئاً في النص.

**توصيات:**
1. للنصوص الرسمية والقانونية والتعليمية: اكتب بالفصحى قبل التشكيل.
2. إن كان لا بد من العامية (حوارات، شعر شعبي): استخدم مستوى «أدنى» (minimal) أو شكّل يدوياً
   الكلمات المهمة، واقفل التشكيل الصحيح في القاموس الشخصي (الأسماء والعبارات المتكررة).
3. راجع الكلمات منخفضة الثقة، وخصوصاً أواخر الكلمات (الإعراب)؛ فالعامية لا إعراب لها.
4. حزمة الأسماء `mizaj-names-eg-gulf-levant.mizajpack` تساعد في الأعلام والأماكن الشائعة.

**حدود معروفة:** لا يوجد نموذج مخصص للهجات؛ لا تحويل من العامية إلى الفصحى؛ لا يعالج الكتابة
اللاتينية للعربية (عربيزي)؛ المغاربية واليمنية والسودانية غير مغطاة بقوائم العلامات.

## English

**Summary.** Mizaj's diacritization engines are trained on and designed for Modern Standard and
Classical Arabic. Dialectal text (Egyptian, Gulf, Levantine, Maghrebi, ...) is still processed, but
the result is **less reliable**, and standard i'rab vowels may be added where no speaker would
pronounce them.

**What the engine does with dialect text**
- Each word is treated as if it were standard Arabic. Words such as عايز, دلوقتي, بتاع, هلق are
  absent from standard lexicons, so the neural model (CATT) guesses and the fast engine (mishkal)
  falls back to standard morphological guesses.
- Letters are never changed: `strip_marks(output) == strip_marks(input)` holds on every path.
- Per-word confidences (`confidence` in `/api/tashkeel`) are usually low on dialect, so the UI can
  highlight words to review.

**Warning signal.** `POST /api/text/dialect-hint` with `{"text": "..."}` returns
`{likely_dialectal, score, dialect, markers[]}`. It is a lightweight heuristic over closed marker
lists (Egyptian: ده دي عايز مش إزاي; Gulf: وايد شلون شفيك; Levantine: هلق شو كتير ...).
A negative answer does not mean the text is standard Arabic; the lists are short on purpose to avoid
false alarms. The text never leaves the machine and is never modified.

**Recommendations**
1. For official, legal and teaching text, write in standard Arabic before diacritizing.
2. If dialect is unavoidable (dialogue, vernacular poetry), use the `minimal` level or diacritize
   key words by hand, and lock correct forms in the personal dictionary.
3. Review low-confidence words, especially word endings: dialects have no case endings.
4. The `mizaj-names-eg-gulf-levant.mizajpack` pack covers common names and places.

**Limitations.** There is no dialect-specific model; no dialect-to-standard conversion; romanized
Arabic (Arabizi) is not handled; Maghrebi, Yemeni and Sudanese markers are not in the lists.
