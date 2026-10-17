# Tashkeel accuracy

Corpus: 152 sentences, 956 words. DER/WER in %, lower is better. Conventions: see `eval/metrics.py` (Arabic letters only; `all` = every letter, `gold-only` = letters that carry a diacritic in the gold text).

| Engine | Scope | DER w/ case | WER w/ case | DER w/o case | WER w/o case | internal DER | final (i'rab) DER | shadda err | words/s |
| :--- | :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| mock | all letters | 75.70 | 99.89 | 75.23 | 95.92 | 75.23 | 75.52 | 100.00 | 25675.3 |
| mock | gold-only | 84.39 | 99.16 | 87.58 | 95.92 | 87.58 | 70.97 | 100.00 | 25675.3 |
| fast | all letters | 10.76 | 37.34 | 6.86 | 17.57 | 6.48 | 25.84 | 11.18 | 171.6 |
| fast | gold-only | 12.75 | 35.46 | 7.64 | 15.17 | 7.14 | 30.40 | 11.18 | 171.6 |
| accurate | all letters | 3.33 | 13.07 | 2.43 | 7.32 | 2.27 | 6.59 | 4.79 | 695.9 |
| accurate | gold-only | 4.20 | 12.76 | 3.12 | 7.11 | 2.91 | 7.69 | 4.79 | 695.9 |
| accurate+mf1 | all letters | 3.58 | 14.12 | 2.75 | 8.47 | 2.59 | 6.59 | 4.79 | 224.5 |
| accurate+mf1 | gold-only | 4.54 | 13.91 | 3.55 | 8.37 | 3.34 | 7.69 | 4.79 | 224.5 |
| accurate+mf2 | all letters | 3.26 | 12.55 | 2.35 | 6.80 | 2.19 | 6.59 | 4.79 | 396.2 |
| accurate+mf2 | gold-only | 4.12 | 12.34 | 3.01 | 6.70 | 2.80 | 7.69 | 4.79 | 396.2 |
| accurate-int8+mf2 | all letters | 3.24 | 12.45 | 2.38 | 6.90 | 2.21 | 6.49 | 4.79 | 984.7 |
| accurate-int8+mf2 | gold-only | 4.09 | 12.24 | 3.05 | 6.80 | 2.83 | 7.57 | 4.79 | 984.7 |

## By category (DER / WER, with case ending, all letters)

| Engine | general | legal | letters | news |
| :--- | ---: | ---: | ---: | ---: |
| mock | 73.64 / 99.68 | 77.41 / 100.00 | 77.01 / 100.00 | 75.47 / 100.00 |
| fast | 11.28 / 38.06 | 10.38 / 34.02 | 12.02 / 41.62 | 9.59 / 36.68 |
| accurate | 3.10 / 12.58 | 2.82 / 10.66 | 3.15 / 13.29 | 4.24 / 16.16 |
| accurate+mf1 | 3.24 / 12.58 | 3.07 / 11.88 | 4.08 / 17.92 | 4.16 / 15.72 |
| accurate+mf2 | 3.03 / 11.61 | 2.82 / 10.66 | 3.27 / 13.87 | 3.99 / 14.85 |
| accurate-int8+mf2 | 2.96 / 11.29 | 2.82 / 10.66 | 3.15 / 13.29 | 4.08 / 15.28 |
