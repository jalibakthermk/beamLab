# Migration report: import/ → data/regulations (2026-11-14)

**Sources** (in `import/`, not committed):

- `UNR_R148_Rev0_Amendment5.pdf`: UN Regulation No. 148 (light-signalling devices), Rev.0 Amendment 5, E/ECE/TRANS/505/Rev.3/Add.147/Amend.5, 56 pages.
- `UNR_R149_Rev0_Amend6.pdf`: UN Regulation No. 149 (road illumination devices), Rev.0 Amendment 6, E/ECE/TRANS/505/Rev.3/Add.148/Amend.6, 110 pages.

**Method:** values transcribed from the PDF text layer and checked against the rendered pages (figures read at 220 dpi). An independent script re-read the tables from the text layer and compared every converted intensity (137 values) and every R149 angle (50 values) with the files. There were 0 transcription mismatches; the 2 flags were checker parsing artefacts, checked by hand. Every file has `"verified": false`. Sign convention: L = negative H, R = positive H, U = positive V, D = negative V.

## Converted: 29 files

| Source | Files | Elements |
|---|---|---|
| R149 Table 6 (para. 5.2.2) | Class C passing beam; Class V passing beam | 25; 25 |
| R148 Table 3 + Figure A3-I | front position / end-outline A, MA, AM | 20 |
| R148 Table 4 + Figure A3-I | rear position R1/MR/RM1; R2/RM2 | 20 each |
| R148 Table 5 + Figure A3-I | parking forward; rearward | 20 each |
| R148 Table 6 + Figure A3-II | daytime running RL | 21 |
| R148 Table 7 + Figures A3-I / A3-III | stop S1, S2, MS (A3-I); S3, S4 (A3-III) | 20; 16 |
| R148 Table 8 + Figure A3-I | direction indicators 1, 1a, 1b, 2a, 2b, 11, 11a, 11b, 11c, 12 | 20 each |
| R148 Table 8 + Figure A3-IV | direction indicator category 6 | 17 |
| R148 Table 9 + Figures A3-VII / VIII | side markers SM1, SM2 | 3 each |
| R148 Table 10 + Figure A3-V | reversing AR | 25 |
| R148 Table 11 + Figure A3-VI | rear fog F1, F2 | 5 each |

## Points to check in the source

1. **R148 Table 8, categories 11a, 11b, 11c:** the single-lamp maximum is printed as **1.20∙10²** cd, below the minima (175 / 250 / 400 cd). Category 11 prints 1.20∙10³. Copied as printed; any lamp will fail these files until the source is checked.
2. **R148 Table 8, category 11c:** the minimum is printed "4,00∙10²" (comma as decimal mark), read as 400 cd.

## Left out or null (not representable, or not stated)

- **R149 Table 6:** overhead-sign requirements S50+S50LL+S50RR ≥ 190 cd and S100+S100LL+S100RR ≥ 375 cd (Class C). These limit a *sum* of three points; the schema has no sum element. Positions are given in Table 6 Part B.
- **R149 Table 6:** "Segment 10 and below" is encoded on the segment at 4°D only; the region below it has no stated lower bound.
- **R149 Table 6 notes:** a (matched pair: each lamp ≥ 50% of the minimum) and b (position lamps may be on) are not encoded. The same goes for para. 5.2.3 (no lateral variations in zone III) and the elbow position "basically within ±0.5°" (Annex 5, 3.2.1.2 (c)).
- **R148:** angles of geometric visibility (Annex 2 Tables A2-1 to A2-4) depend on the lamp side and mounting height; only their minimum is kept, as parameter `Igeo_min` (and `Igeo_min_night` where given). Also not encoded: the uniformity rule of Annex 3 para. 1.2; the option of checking only down to 5°D for mounting heights ≤ 750 mm (Annex 3, 1.1); "VV to outboard only" options; the 60 cd allowance for lamps reciprocally incorporated with stop lamps; the red side-marker forward limit; the paired-reversing-lamp 30° option.
- **R148, "D"-marked lamps:** their lower maximum is kept as parameter `Imax_D`; the files check the single-lamp maximum.
- **Not converted:** direction indicator category 5 (defined by Table A2-2, depends on the lamp side); rear-registration plate lamps (luminance on the plate, not intensity); Tables 12 and 13 (conformity-of-production tolerances); Annex 8 (time-dependent checks).
- **R149, other sections, not yet converted:** driving beams Class A, B, RA (Tables 3a, 3b, 4, 5); AFS (Tables 7–12); ADB (Table 13); symmetrical passing beams AS, BS, CS, DS and secondary driving beams (Tables 14–16); front fog F3 (Tables 17–18); cornering K; section 6 (CoP, Tables 19–21).

## Assumptions

1. **R149, left-hand traffic:** Table 6 is "indicated for right-hand traffic". The text describes the mirrored cut-off shape (Annex 5, 2.1.1 (b)) but does not state that the values mirror, so `mirrorForLeftHandTraffic` is **false**.
2. **R149 aim:** nominal cut-off V = −0.57 ("one per cent (0.57°) below the H-H line", Annex 5, 3.2.1.1); re-aim range ±0.75° H, ±0.25° V (Annex 5, 4.1 (a), passing beam). These are applied to both Class C and V, because Annex 5 para. 3.2 covers "Classes C and V".
3. **R148 direction indicator category 6:** Figure A3-IV measures H towards the outer side of the vehicle; the file uses positive H = outer side (a lamp on the right side). For a left-side lamp, mirror the dataset (flipH).
4. **R148 grid point names** (e.g. "5U-10L") are made up for this tool; the figures do not name the points.
5. **R148 aim:** signal lamps are measured as loaded on their reference axis; only the "as loaded" aim mode is enabled and the re-aim range is null.
6. **R148 reversing lamps:** the three maximum zones are encoded over the whole H range (−180° to 180°) of their V band, as the text states. They are "not evaluated" unless the data covers the full band.
