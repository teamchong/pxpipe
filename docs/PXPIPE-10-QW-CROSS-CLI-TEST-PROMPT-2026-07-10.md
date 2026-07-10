# Prompt testowy pxpipe: 10 quick wins × Codex CLI × Claude Code

Poniższy prompt jest samodzielny. Należy wkleić go jako pierwszy prompt nowej sesji
uruchomionej z `D:\JaskierTools\pxpipe` w Codex CLI albo Claude Code.

```text
Wykonaj pełny, reprodukowalny eksperyment A/B, implementację zaakceptowanych zmian
i finalizację produkcyjną dziesięciu quick wins pxpipe dla Codex CLI oraz Claude Code.
Pracuj autonomicznie aż do merge i cleanup; nie pytaj o zgodę na standardowe kroki.

## 0. Start, pamięć i potwierdzenie repozytorium

To jest nowa sesja. Najpierw, bez wyszukiwania na ślepo, odczytaj bezpośrednio:

1. `C:\Users\BIURODOM\.claude\projects\D--JaskierWorkspace\memory\MEMORY.md`
2. `D:\JaskierWorkspace\CLAUDE.md`
3. `D:\JaskierWorkspace\AGENTS.md`
4. `C:\Users\BIURODOM\.claude\projects\D--JaskierWorkspace\memory\project_pxpipe_10qw_cross_cli_prompt_handoff_2026_07_10.md`

Następnie odczytaj SessionBus inbox/status przez dostępny kanoniczny surface. Jeżeli
narzędzia MCP nie są widoczne, użyj istniejących skryptów `~/.claude/lib/session-*.mjs`
i hooków Codexa; nie buduj nowego mechanizmu koordynacji.

Znana oczekiwana ścieżka repozytorium to `D:\JaskierTools\pxpipe`, ale nie zakładaj,
że jest poprawna tylko dlatego, że została podana. Zweryfikuj ją przez:

- `git -C D:\JaskierTools\pxpipe rev-parse --show-toplevel`;
- `git -C D:\JaskierTools\pxpipe remote -v`;
- ustalenie default branch, push remote, upstream repo i bieżącego SHA;
- sprawdzenie `git status`, aktywnych worktree oraz cudzych zmian.

Jeśli ścieżka nie jest prawidłowym repozytorium pxpipe, zakończ `BLOCKED` z dowodem;
nie szukaj losowo po dysku. Nie nadpisuj ani nie przenoś cudzych zmian. Jeżeli główny
checkout nie jest czysty, utwórz osobny nazwany branch i osobny worktree. Przed każdą
rekurencyjną operacją na worktree zweryfikuj bezwzględną ścieżkę docelową.

Przypnij i zapisz `BASE_SHA`, wersje Codex CLI i Claude Code, modele, profile, proxy,
konfiguracje oraz środowisko. Zbuduj niezależny artefakt A1 z `BASE_SHA`, tak aby
baseline nie zmieniał się podczas implementacji wariantów. A0 musi używać tego samego
korpusu i ustawień, ale z faktycznym bypass pxpipe.

Utwórz jawny plan i aktualizuj go po każdym etapie. Przed pierwszą decyzją
architektoniczną uruchom skill `debata`. Implementację deleguj do bounded workerów z
rozłącznymi write-setami; zmiany krytyczne poddaj niezależnemu reviewerowi. Nie
deleguj mikroblokerów. Wyślij krótki startowy status przez SessionBus.

## 1. Cel i zasada dowodowa

Zbadaj, zaimplementuj, odizoluj i przetestuj dokładnie QW01–QW10 poniżej dla:

- Codex CLI;
- Claude Code.

Każda komórka macierzy 10 × 2 musi zakończyć się `PASS`, `FAIL` albo `N/A` oraz
linkiem lub ścieżką do dowodu. `N/A` nigdy nie znaczy „nie sprawdzono”. Jeżeli zmiana
dotyczy wyłącznie OpenAI, nadal wykonaj dla Claude Code co najmniej trzy live testy
regresji na tym samym candidate buildzie i udowodnij brak odpowiedniego pola lub
surface protokołu. Analogicznie postępuj dla zmian Claude-only.

Nie rasteryzuj ani nie usuwaj natywnej struktury tool schema. Nazwy narzędzi i pól,
typy, `required`, `enum`, `const`, ograniczenia strukturalne oraz kształt obiektów i
tablic muszą pozostać w natywnym JSON dostawcy. Obraz może zawierać wyłącznie
adnotacje przeniesione z tekstu, nigdy jedyną kopię kontraktu wywołania narzędzia.

## 2. Historyczne liczby — wyłącznie kontekst, zmierz wszystko ponownie

Nie przedstawiaj tych wartości jako wyniku nowej sesji:

- pełny prompt: 14 991 → 10 384 tokeny;
- oszczędność: 4 607 tokenów/request, czyli 30,73%;
- przykładowy slab: 5 759 → 1 152 tokeny, czyli 80,00%;
- 2 471 skompresowanych z 2 483 odpowiedzi HTTP 200;
- baseline slabów 30 657 801, image tokens 5 633 640;
- oszczędzone w slabach 25 024 161 tokenów, czyli 81,62%;
- dwa kontrolowane requesty miały `cached_input_tokens=0`;
- brak skutecznego `history_reason="collapsed"`;
- orientacyjne powody odrzucenia: `prefix_too_short` ≈ 1 814,
  `not_profitable` ≈ 494, `below_min_tokens` = 196.

## 3. Wersjonowany korpus i bezpieczne narzędzia

Przygotuj jeden deterministyczny, wersjonowany korpus używany bez zmian przez oba
klienty i wszystkie warianty. Musi zawierać co najmniej:

1. duży system/tool context tworzący pełny obraz oraz częściowy ostatni obraz;
2. złożone tool schema z `required`, `enum`, `const`, zagnieżdżonymi obiektami,
   tablicami, `oneOf` i `anyOf`;
3. długą, zakończoną historię z jednym dużym tool-outputem i zachowanym tail;
4. dokładne ścieżki, URL-e, UUID-y, liczby, daty, polskie znaki i krytyczne negacje;
5. stabilny prefix nadający się do prób cold/warm cache;
6. przypadki graniczne prompt injection, authority boundaries i końców linii `↵`;
7. oczekiwane odpowiedzi oraz oczekiwane wywołania narzędzi.

Wszystkie narzędzia korpusu mają być stubowane, hermetyczne i bez skutków ubocznych.
Nie używaj prawdziwych poświadczeń i nie wykonuj submitów, publikacji, zmian chmury,
infrastruktury, poczty ani GitHuba z poziomu testowanych agentów. Stub ma walidować
nazwę i argumenty wywołania, zwracać syntetyczny wynik i zapisywać zanonimizowany
dowód. Live oznacza prawdziwy request modelowy, ale wyłącznie do syntetycznego korpusu.

## 4. Macierz A/B i powtórzenia

Dla każdego klienta wykonaj:

- `A0`: pxpipe faktycznie pominięty;
- `A1`: niezmieniony pxpipe z przypiętego `BASE_SHA`;
- `B01`…`B10`: każdy quick win odizolowany osobną flagą, buildem lub wariantem
  konfiguracji; wszystkie pozostałe zachowania równe A1;
- `B-all`: łącznie tylko warianty, które przeszły swoje bramki.

Jedyny jawny wyjątek zależności: QW06 wolno oceniać dopiero po poprawnym QW02,
dlatego `B06 = A1 + QW02 + QW06`, a przyrost QW06 mierz jako `B02 → B06`.
Nie przypisuj QW06 oszczędności wniesionych wcześniej przez QW02.

To daje co najmniej 13 wariantów na klienta: A0, A1, B01–B10 i B-all. Dla każdego
live wariantu wykonaj minimum trzy niezależne powtórzenia przy przypiętym modelu,
konfiguracji i temperaturze, jeśli klient ją udostępnia. Zachowaj kolejność korpusu,
ale zrandomizuj lub przeplataj kolejność wariantów, aby ograniczyć bias czasowy.
Raportuj medianę oraz min–max; latency dodatkowo p50/p95. Błędu nie ukrywaj przez
ponawianie — raportuj wszystkie próby i z góry ustaloną politykę retry.

Dla QW07 wykonaj osobno co najmniej jeden cold request i trzy identyczne warm
requesty na klienta i wariant. Cold write, warm read/hit i raw input muszą pozostać
oddzielnymi seriami. Nie dodawaj oszczędności cache do raw token reduction.

## 5. Dziesięć quick wins

### QW01 — pełna telemetria netto

Napraw i pokryj testami parser usage dla SSE oraz non-SSE. Bez utrwalania sekretów
lub prywatnych pełnych promptów loguj:

- klienta, protokół, model i wersję profilu;
- pre/post native text tokens oraz image tokens;
- actual input/output usage dostawcy;
- cached/read/write tokens w oryginalnym nazewnictwie dostawcy;
- koszt fact-sheet, framingu, pointerów i guardów;
- decyzję i powód gate;
- rzeczywiste wymiary każdego obrazu, latency, status i bezpieczny request hash.

PASS: 100% udanych odpowiedzi ma jeden kompletny rekord; nie ma podwójnego liczenia;
usage można zrekoncyliować z odpowiedzią dostawcy; raw compression, cache effect i
koszt są raportowane w osobnych polach oraz tabelach.

### QW02 — dokładny profitability gate

Dla OpenAI zastąp heurystykę `renderedText.length / 4` dokładnym pomiarem
`o200k_base`, korzystając z już dostępnego tokenizera. Koszt obrazu licz z realnej
wysokości każdej częściowej strony, rzeczywistego patch grid i faktycznej liczby
wierszy, w tym `↵`. Dla Claude użyj oficjalnego token-count surface, jeśli jest
dostępny; w przeciwnym razie użyj jawnie skalibrowanego estymatora i oznacz jego
błąd, zamiast udawać pomiar actual.

PASS: zero błędnych decyzji profitable/not-profitable w korpusie; jawny błąd
estymacji; więcej poprawnie kwalifikowanych bloków bez wzrostu rzeczywistego kosztu.

### QW03 — renderowanie wyłącznie delta tool-schema

Nie duplikuj w obrazie outer tool description, jeśli pozostaje natywnie. Nie renderuj
ponownie struktury schema pozostającej w JSON. Do obrazu przenieś tylko adnotacje
tekstowe rzeczywiście usuwane z reprezentacji natywnej, np. opis konkretnego pola.

PASS: natywna struktura przed/po jest semantycznie identyczna; wszystkie nazwy, typy,
`required`, `enum` i `const` pozostają dostępne natywnie; image/full-prompt tokens
spadają; tool-call exact-match nie pogarsza się.

### QW04 — source-aware fact-sheet z budżetem tokenowym

Fact-sheet ma zawierać wyłącznie fakty rzeczywiście usunięte z tekstu. Deduplikuj go
względem natywnego tool schema. Rozdziel źródła authority/system i tool docs; nadaj
authority/system pierwszeństwo, a tool docs osobny mały budżet. Budżetuj dokładnymi
tokenami, a nie wyłącznie liczbą wpisów. Zachowaj krytyczne negacje.

PASS: zero utraconych krytycznych identyfikatorów, liczb i negacji; zero zbędnych
duplikatów względem natywnego JSON; mierzalny spadek fact-sheet i transformed input.

### QW05 — adaptacyjne kompresowanie historii

Pozwól zakwalifikować pojedynczy duży, zakończony tool-output bez wymagania
`minCollapsePrefix=10`. Nigdy nie kompresuj aktywnego wywołania, bieżącego tail,
systemowych uprawnień, nierozwiązanej pary tool-call/tool-result ani wiadomości
potrzebnych do kontynuacji protokołu.

PASS: udokumentowany wzrost kwalifikowanych przypadków; dodatnia oszczędność netto;
pełna poprawność pytań zależnych od zachowanej historii i kolejności protokołu.

### QW06 — ostrożne obniżenie progu historii

Testuj dopiero po zaliczeniu QW02. Wykonaj sweep co najmniej 1 200, 1 350 i 1 500
tokenów wobec bazowych 2 000 i wybierz próg wyłącznie na podstawie A/B.

PASS: odblokowana jest część `below_min_tokens`; każdy zaakceptowany collapse ma
dodatni wynik netto; brak regresji odpowiedzi, recall historii i tool calls.

### QW07 — deterministyczny prefix i bezpieczny cache key

Dla obsługiwanych modeli OpenAI dodaj stabilny, namespacowany `prompt_cache_key`
oparty na bezpiecznym hashu wersji pxpipe, profilu, systemu i toolsetu. Nie umieszczaj
w nim sekretów ani surowej treści. Kanonizuj kolejność tool docs i prefix bez zmiany
ich semantyki. Dla Claude sprawdź jego natywny prompt-cache surface i zachowaj go
bezpiecznie, jeśli pxpipe ma odpowiedni surface; w przeciwnym razie oznacz `N/A` z
dowodem protokołowym i wykonaj trzy live próby regresji.

PASS: warm requests wykazują rzeczywiste provider-native cached/read tokens; cold
write i warm read są rozliczone oddzielnie; brak kolizji między tenantami, modelami,
profilami i toolsetami; brak zmiany poprawności. Cache może zwiększać lub zmniejszać
koszt, ale nigdy nie jest doliczany do raw token savings.

### QW08 — minifikacja framingu

Zastąp powtarzane HEADER/END/guardy jedną minimalną legendą lub pointerem, zachowując
autorytet, jawne granice treści, kolejność i odporność na prompt injection.

PASS: spadek framing tokens; 100% testów granic, autorytetu, dokładnych negacji i
injection; brak pogorszenia OCR, tool-call oraz instruction following.

### QW09 — kalibracja profilu `gpt-5.6-sol`

Najpierw zweryfikuj w kodzie rzeczywisty identyfikator profilu; nie zgaduj. Jeżeli
`gpt-5.6-sol` nie istnieje, zapisz dokładny znaleziony identyfikator i dowód mapowania.
Wykonaj offline grid-search `stripCols × maxHeightPx` oraz end-to-end canary. Jeśli
Claude ma niezależny profil renderowania, kalibruj go osobno; w przeciwnym razie
wykonaj trzy live testy regresji i uzasadnij `N/A`.

PASS: wybrany jest wyłącznie wariant Pareto dający mniej rzeczywistych image tokens
bez spadku OCR, exact identifiers lub tool-call; zachowany jest pełny wynik siatki;
profile innych modeli nie zmieniają się.

### QW10 — wyrównanie wysokości do patch grid

Sprawdź pełną stronę 1 920 px zamiast 1 928 px oraz najbliższe sensowne granice
patch grid. Nie przedstawiaj teoretycznych 24 tokenów jako pomiaru; potwierdź wynik
provider-native usage albo oznacz brak obserwowalności.

PASS: brak nadmiarowego rzędu patchy; rzeczywisty koszt obrazu nie rośnie; identyczna
czytelność, exact-identifier accuracy, OCR i poprawność end-to-end.

## 6. Wspólne bramki bezpieczeństwa

Quick win może wejść do B-all i zostać domyślnie włączony tylko wtedy, gdy:

- snapshot i structural-schema tests przechodzą w 100%;
- natywne nazwy, typy, `required`, `enum`, `const` i kształt schema są zachowane;
- dokładne identyfikatory oraz krytyczne negacje mają 100% poprawności;
- żadna krytyczna instrukcja nie została utracona, osłabiona ani odwrócona;
- tool name i wymagane argumenty są poprawne we wszystkich fixtures krytycznych;
- wynik end-to-end nie jest gorszy od A1 dla żadnego klienta;
- OCR nie jest gorszy od A1; raportuj CER/WER, ale gate exact identifiers ma
  pierwszeństwo;
- nie pojawiły się nowe błędy HTTP, parsera, timeouty, wycieki danych ani procesy
  pozostawione w tle.

FAIL nie może być maskowany przez B-all. Ryzykowną, ale wartościową zmianę pozostaw
za udokumentowaną flagą tylko wtedy, gdy ma jednoznaczny rollback. Usuń martwy kod
eksperymentalny przegranych wariantów. Zmianę OpenAI-only przyjmij dopiero po zielonej
regresji Claude; zmianę Claude-only — po zielonej regresji Codex.

## 7. KPI i formuły raportu

Dla każdej serii pokaż wartości bezwzględne oraz:

- raw full-prompt reduction A0→X:
  `(A0 actual input tokens - X actual input tokens) / A0 actual input tokens`;
- incremental reduction A1→X:
  `(A1 actual input tokens - X actual input tokens) / A1 actual input tokens`;
- dla zależnego QW06 dodatkowo incremental reduction B02→B06, bez podwójnego
  przypisywania efektu QW02;
- slab reduction, native text, fact-sheet, framing, pointer/guard i image tokens;
- cache read, cache write, hit ratio oraz osobny provider-native koszt cache;
- provider-native billable equivalent i koszt z datą oraz źródłem wersji cennika;
- latency p50/p95, HTTP/client success rate i retry count;
- collapse eligibility oraz wszystkie powody odrzucenia;
- OCR CER/WER, exact-identifier accuracy i tool-call exact-match.

`actual input tokens` w formule raw pozostaje całym wejściem niezależnie od tego, jaka
część została odczytana z cache. Oszczędności cache pokaż wyłącznie w osobnej tabeli
kosztowej/latency. Nie sumuj procentów. Jeśli dostawca nie zwraca danej metryki,
oznacz ją `not observable`; estymację pokaż osobno z nazwą estymatora i błędem.

## 8. Artefakty i macierz 10 × 2

Utwórz wersjonowany katalog ewaluacji zgodny z konwencją repozytorium. Ma zawierać:

- manifest środowiska, wersje klientów/modeli/profili i `BASE_SHA`;
- korpus oraz wyłącznie bezpieczne fixtures/stuby;
- konfiguracje A0, A1, B01–B10 i B-all;
- `baseline.json`, `qw01.json`…`qw10.json` i `combined.json`;
- zanonimizowane JSONL/CSV z wszystkimi repetycjami;
- raport OCR, exact identifiers i tool-call correctness;
- raport Markdown z formułami, medianą, zakresem, kosztami i rekomendacją;
- instrukcję reprodukcji, feature flags i rollback;
- następującą kompletną macierz z linkiem do dowodu w każdej komórce:

| Quick win | Codex CLI | Claude Code | Dowód Codex | Dowód Claude |
|---|---|---|---|---|
| QW01 Telemetria netto | PASS/FAIL/N/A | PASS/FAIL/N/A | link | link |
| QW02 Dokładny gate | PASS/FAIL/N/A | PASS/FAIL/N/A | link | link |
| QW03 Delta tool-schema | PASS/FAIL/N/A | PASS/FAIL/N/A | link | link |
| QW04 Source-aware fact-sheet | PASS/FAIL/N/A | PASS/FAIL/N/A | link | link |
| QW05 Historia adaptacyjna | PASS/FAIL/N/A | PASS/FAIL/N/A | link | link |
| QW06 Próg historii | PASS/FAIL/N/A | PASS/FAIL/N/A | link | link |
| QW07 Prefix i cache key | PASS/FAIL/N/A | PASS/FAIL/N/A | link | link |
| QW08 Framing | PASS/FAIL/N/A | PASS/FAIL/N/A | link | link |
| QW09 Profil modelu | PASS/FAIL/N/A | PASS/FAIL/N/A | link | link |
| QW10 Patch grid | PASS/FAIL/N/A | PASS/FAIL/N/A | link | link |

Nie commituj sekretów, prywatnych promptów, provider responses z danymi użytkownika
ani wielkich surowych logów. Duże lokalne artefakty zachowaj poza Gitem; w PR dodaj
ich zanonimizowane podsumowanie, manifest i SHA-256.

Po A1 oraz po B-all zapisz checkpoint do Shared Memory i wyślij status przez
SessionBus. Nie skracaj istniejącego `MEMORY.md`; dodaj tylko zwięzły link do nowego
datowanego pliku.

## 9. Review, decyzja i finalizacja bez zatrzymania na PR

Po zakończeniu implementacji:

1. wykonaj niezależne review patcha i napraw wszystkie trafne uwagi;
2. odczytaj `packageManager` i dostępne skrypty z manifestu, następnie uruchom
   wszystkie skonfigurowane bramki repozytorium oraz cross-client smoke A1/B-all.
   Obecny manifest wskazuje `pnpm@10.21.0`, ale zweryfikuj pin w bieżącym checkoutcie.
   Nie wymyślaj komend `lint` ani security, jeśli repo ich nie definiuje: oznacz je
   `not configured` z dowodem; co najmniej istniejące `test`, `typecheck` i `build`
   muszą przejść;
3. sprawdź diff, zakres plików, brak sekretów i brak przypadkowych artefaktów;
4. commituj na nazwanym branchu i wypchnij do zweryfikowanego push remote;
5. otwórz PR do zweryfikowanego właściwego default branch; w opisie umieść macierz
   10 × 2, wyniki A/B, koszty, flagi i rollback;
6. doprowadź wszystkie wymagane checki oraz review do zielonego stanu bez admin
   bypass i bez wyłączania ochrony brancha;
7. zmerge'uj zgodnie z polityką repozytorium;
8. zapisz PR URL i merge SHA;
9. bezpiecznie usuń zakończony worktree oraz branch lokalny/zdalny, wróć do default
   branch, wykonaj pull i potwierdź czysty stan oraz obecność merge SHA.

Nie kończ na lokalnym patchu, samym pushu ani otwartym PR. Nie używaj force-push.
Jeżeli check ujawni błąd, popraw go w tym samym cyklu. `PASS` wymaga dowodu live,
nie tylko testu jednostkowego.

## 10. Shared Memory, prompt wznowienia, schowek i zakończenie sesji

Po merge utwórz lub rozszerz datowany raport:

`C:\Users\BIURODOM\.claude\projects\D--JaskierWorkspace\memory\project_pxpipe_10qw_cross_cli_2026_07_10.md`

Raport ma zawierać: cel sesji, `BASE_SHA`, finalny SHA, PR URL, merge SHA, wersje obu
klientów i modeli, macierz 10 × 2, A0/A1/B01–B10/B-all, mediany i zakresy, rozdzielone
raw/cache/cost savings, aktywne flagi, ścieżki artefaktów, znane ograniczenia,
rollback, stan cleanup oraz następne kroki. Do `MEMORY.md` dodaj wyłącznie zwięzły
link/indeks — niczego nie usuwaj ani nie kondensuj. Wyślij finalny status i ścieżkę
raportu przez SessionBus.

Niezależnie od sukcesu lub blokera przygotuj jeden samodzielny prompt wznowienia,
który nowej sesji pozwoli kontynuować bez tej rozmowy. Musi zawierać dokładny stan,
repo, branch/worktree, ostatni poprawny etap, PR/merge/checki, ścieżki dowodów, wyniki
macierzy i wyłącznie pozostałe kroki. Bez sekretów. Zapisz go do:

`D:\JaskierWorkspace\data\SharedMemory\resume-pxpipe-10-qw-crosscli-<YYYY-MM-DD>.md`

Użyj rzeczywistej daty sesji zamiast `<YYYY-MM-DD>` i dodaj krótki pointer do
`D:\JaskierWorkspace\data\SharedMemory\AGENT_MEMORY.md` bez skracania istniejącej
treści. Raport szczegółowy pozostaje w auto-injected Shared Memory v2 pod ścieżką
podaną wyżej, a ten plik jest kanonicznym handoffem cross-CLI.

Skopiuj dokładną treść tego pliku do schowka Windows przez `Set-Clipboard`, następnie
odczytaj schowek i porównaj długość oraz SHA-256 z plikiem. Samo wywołanie
`Set-Clipboard` bez weryfikacji nie jest dowodem.

Końcowa odpowiedź `FINAL_ANSWER` ma podać co najmniej: status, PR URL, merge SHA,
macierz 10 × 2, raw savings, osobne cache/cost savings, ścieżkę raportu Shared Memory,
ścieżkę promptu wznowienia, potwierdzenie schowka i czystego worktree. Po wysłaniu
finalnej odpowiedzi zakończ sesję i nie pozostawiaj procesów, serwerów ani watcherów.

Jeżeli wystąpi rzeczywisty twardy bloker, nie ogłaszaj sukcesu. Zapisz checkpoint do
Shared Memory, wyślij `BLOCKED` przez SessionBus, skopiuj zweryfikowany prompt
wznowienia do schowka, posprzątaj wyłącznie bezpieczne zasoby i zakończ sesję ze
statusem `BLOCKED`, dokładnym dowodem oraz jednym konkretnym następnym krokiem.
```

## Krótka checklista pokrycia promptu

- [x] Dokładnie QW01–QW10, bez dodawania jedenastego wariantu.
- [x] Macierz 10 × 2: Codex CLI i Claude Code, z dowodem dla `N/A`.
- [x] A0, A1, B01–B10 i B-all oraz minimum trzy live repetycje.
- [x] Stubowane narzędzia i brak realnych skutków ubocznych.
- [x] Natywna struktura tool schema zachowana.
- [x] Raw compression oddzielona od cache oraz kosztu.
- [x] Weryfikacja `D:\JaskierTools\pxpipe`, przypięty `BASE_SHA` i osobny baseline.
- [x] Shared Memory, SessionBus, commit → push → PR → checks → merge → cleanup.
- [x] Prompt wznowienia zapisany, zweryfikowany w schowku i zakończenie sesji.
