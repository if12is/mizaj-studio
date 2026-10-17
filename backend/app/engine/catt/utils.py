# Vendored and trimmed from catt-tashkeel 1.0.2 (https://github.com/abjadai/catt),
# Copyright (c) Faris Alasmary / Abjad AI, licensed under the Apache License 2.0.
# Modifications: removed download/tqdm code, encoder-only inference only. See NOTICE.
"""Arabic diacritic patterns used by the CATT tokenizer."""
import re

COMMA = '\u060C'
SEMICOLON = '\u061B'
QUESTION = '\u061F'
HAMZA = '\u0621'
ALEF_MADDA = '\u0622'
ALEF_HAMZA_ABOVE = '\u0623'
WAW_HAMZA = '\u0624'
ALEF_HAMZA_BELOW = '\u0625'
YEH_HAMZA = '\u0626'
ALEF = '\u0627'
BEH = '\u0628'
TEH_MARBUTA = '\u0629'
TEH = '\u062a'
THEH = '\u062b'
JEEM = '\u062c'
HAH = '\u062d'
KHAH = '\u062e'
DAL = '\u062f'
THAL = '\u0630'
REH = '\u0631'
ZAIN = '\u0632'
SEEN = '\u0633'
SHEEN = '\u0634'
SAD = '\u0635'
DAD = '\u0636'
TAH = '\u0637'
ZAH = '\u0638'
AIN = '\u0639'
GHAIN = '\u063a'
TATWEEL = '\u0640'
FEH = '\u0641'
QAF = '\u0642'
KAF = '\u0643'
LAM = '\u0644'
MEEM = '\u0645'
NOON = '\u0646'
HEH = '\u0647'
WAW = '\u0648'
ALEF_MAKSURA = '\u0649'
YEH = '\u064a'
MADDA_ABOVE = '\u0653'
HAMZA_ABOVE = '\u0654'
HAMZA_BELOW = '\u0655'
ZERO = '\u0660'
ONE = '\u0661'
TWO = '\u0662'
THREE = '\u0663'
FOUR = '\u0664'
FIVE = '\u0665'
SIX = '\u0666'
SEVEN = '\u0667'
EIGHT = '\u0668'
NINE = '\u0669'
PERCENT = '\u066a'
DECIMAL = '\u066b'
THOUSANDS = '\u066c'
STAR = '\u066d'
MINI_ALEF = '\u0670'
ALEF_WASLA = '\u0671'
FULL_STOP = '\u06d4'
BYTE_ORDER_MARK = '\ufeff'

# Diacritics
FATHATAN = '\u064b'
DAMMATAN = '\u064c'
KASRATAN = '\u064d'
FATHA = '\u064e'
DAMMA = '\u064f'
KASRA = '\u0650'
SHADDA = '\u0651'
SUKUN = '\u0652'

#Ligatures
LAM_ALEF = '\ufefb'
LAM_ALEF_HAMZA_ABOVE = '\ufef7'
LAM_ALEF_HAMZA_BELOW = '\ufef9'
LAM_ALEF_MADDA_ABOVE = '\ufef5'
SIMPLE_LAM_ALEF = '\u0644\u0627'
SIMPLE_LAM_ALEF_HAMZA_ABOVE = '\u0644\u0623'
SIMPLE_LAM_ALEF_HAMZA_BELOW = '\u0644\u0625'
SIMPLE_LAM_ALEF_MADDA_ABOVE = '\u0644\u0622'


HARAKAT_PAT = re.compile("["+"".join([FATHATAN, DAMMATAN, KASRATAN,
                                        FATHA, DAMMA, KASRA, SUKUN,
                                        SHADDA])+"]")
HAMZAT_PAT = re.compile("["+"".join([WAW_HAMZA, YEH_HAMZA])+"]")
ALEFAT_PAT = re.compile("["+"".join([ALEF_MADDA, ALEF_HAMZA_ABOVE,
                                       ALEF_HAMZA_BELOW, HAMZA_ABOVE,
                                       HAMZA_BELOW])+"]")
LAMALEFAT_PAT = re.compile("["+"".join([LAM_ALEF,
                                          LAM_ALEF_HAMZA_ABOVE,
                                          LAM_ALEF_HAMZA_BELOW,
LAM_ALEF_MADDA_ABOVE])+"]")

def strip_tashkeel(text):
    text = HARAKAT_PAT.sub('', text)
    text = re.sub("[\u064E]", "", text,  flags=re.UNICODE) # fattha
    text = re.sub("[\u0671]", "", text,  flags=re.UNICODE) # waSla
    return text

def strip_tatweel(text):
    return re.sub('[%s]' % TATWEEL, '', text)

# remove removing Tashkeel + removing Tatweel + non Arabic chars
def remove_non_arabic(text):
    text = strip_tashkeel(text)
    text = strip_tatweel(text)
    return ' '.join(re.sub("[^\u0621-\u063A\u0641-\u064A ]", " ", text,  flags=re.UNICODE).split())

