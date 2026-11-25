# Hälsodagbok

En personlig hälsodagbok som webbapp för iPhone. Den används för att logga mående, mediciner, morgonstelhet och anteckningar varje dag, för att över tid se vad som hjälper.

Appen ger inga medicinska råd. Ändringar av mediciner görs alltid tillsammans med läkaren.

## Vad som finns

- **I dag:** daglig incheckning. Skalor 0–10, morgonstelhet, sömn (timmar och kvalitet), vila under dagen (ja/nej), avbockning av fasta mediciner, vid behov-mediciner med tid och dos, kondition samt styrka och rörlighet (typ, tid och ansträngning för var och en), alkohol, kost, markeringar (t.ex. Raynaud, feber, dålig period), anteckning och foton. Allt sparas automatiskt. Pilarna bläddrar till tidigare dagar.
- **Medicin:** fasta mediciner (varje dag eller vissa veckodagar, t.ex. Metotrexat på tisdagar) och vid behov. En veckomedicin visas för avbockning bara på sina dagar; övriga dagar ligger den under "Inte schemalagt i dag". Varje dosändring, utsättning och återinsättning sparas som historik med datum och kommentar.
- **Analys:**
  - Senaste 7 dagarna jämfört med veckan innan.
  - Grafer över tid för varje skala (dagsvärden och 7-dagarssnitt), sömn, vila, kondition, styrka och rörlighet (staplarna mörkare ju hårdare passet var), alkohol och vid behov-medicin. Medicinändringar och dåliga perioder markeras. Dra fingret över en graf för att se en enskild dag. Under "Jämför med" väljs en skala (standard Allmänt mående) som ritas in i alla grafer: som streckat 7-dagarssnitt i skalgraferna och dag för dag med egen skala till höger i staplarna.
  - Möjliga samband: appen jämför dagar med och utan kort sömn, dålig sömn, vila under dagen, konditionsträning, hård konditionsträning, styrke- och rörlighetsträning, hård styrketräning, alkohol, hög stress, varje kostmarkering och dosdagar för veckomediciner, samma dag och upp till två dagar efter. Visas från 14 dagars data.
  - Före och efter medicinändringar, med valbar period (14, 28 eller 56 dagar).
- **Historik:** dag för dag med de två översta skalorna, markeringar, sömn, träning, alkohol, vid behov-intag och anteckning.
- **Mer:** lägga till, ta bort, byta namn på, dölja och sortera skalor, besvär och åkommor, konditionstyper, styrke- och rörlighetstyper samt kost. Borttagna val försvinner från incheckningen men det som redan loggats finns kvar. Export av säkerhetskopia (JSON) och CSV för Numbers/Excel. Import av säkerhetskopia.

## Hur sambanden räknas

För varje kombination av påverkan (t.ex. alkohol) och utfall (t.ex. energi) jämförs snittet på dagar med och utan påverkan, samma dag, dagen efter och två dagar efter. En dag med incheckning där något inte är markerat räknas som "nej" (t.ex. ingen alkohol), utom sömn som bara räknas när den är ifylld. Stress behandlas som påverkan, inte som utfall.

Eftersom hundratals jämförelser görs samtidigt används Benjamini–Hochberg-metoden för att hålla nere antalet mönster som bara är slump (falsk upptäcktsfrekvens 5 %, "tydligt mönster" vid 1 %). Varje grupp måste ha minst 5 dagar och skillnaden minst 0,5 på skalan. I simulering med helt slumpmässig data visas något falskt mönster i ungefär var tionde körning, och verkliga effekter i storleksordningen 1,5 skalsteg hittas i de flesta fall efter två månader.

Mönstren är jämförelser, inte bevis för orsakssamband.

## Data och integritet

- All data lagras först lokalt på telefonen (IndexedDB), så appen fungerar utan uppkoppling.
- Med synk påslagen skickas ändringar till Supabase (se nedan) och hämtas på andra telefoner.
- Ingen spårning, inga externa bibliotek. Appen får bara kontakta det egna Supabase-projektet (Content-Security-Policy i `index.html`).
- Export av säkerhetskopia (JSON) och CSV fungerar alltid, oberoende av server.

## Synk

- **Inloggning.** Under Mer loggar man in med e-post och lösenord. Allt som finns på telefonen skickas upp, och det som finns på servern hämtas.
- **Läsbar data.** Datan lagras okrypterad i Supabase (tabellerna `records` och `photos`) och kan ses under Table Editor. Den skyddas av inloggningen och databasens radsäkerhet: utan användarens konto kommer ingen åt den via appen eller API:et. Den som har tillgång till Supabase-kontot kan läsa den.
- **Läsbara vyer.** `dagbok` visar en rad per dag med varje skala, sömn, vila, träning, alkohol, kost, besvär, tagna mediciner (med dos för dagen), vid behov-intag och anteckning i egna kolumner. `medicinhistorik` visar varje insättning, dosändring, utsättning och vid behov-intag. Egna skalor och besvär får de namn de har fått i appen. Vyerna hittas i Table Editor och kan exporteras som CSV därifrån.
- **Ny telefon.** Logga in under Mer, så hämtas all data inklusive foton.
- **Konflikter.** Senaste ändring vinner per post, både i appen och i databasen (en äldre version kan aldrig skriva över en nyare).
- **Utan nät** sparas allt lokalt och skickas när det finns uppkoppling igen. Raden "Sparat 14:02 och synkat" på dagens sida visar läget.
- **Radera.** Under Mer kan all data på servern raderas (kräver att man skriver RADERA). Datan på telefonen finns kvar. Andra telefoner märker raderingen och slutar synka tills någon loggar in igen.

### Sätta upp Supabase (en gång)

1. **Kör databasskriptet.** Öppna projektet på supabase.com → **SQL Editor** → **New query**. Klistra in hela `supabase/setup.sql` och tryck **Run**. Skriptet skapar tabellerna `sync_state`, `records` och `photos` och vyerna `dagbok` och `medicinhistorik`, med radsäkerhet så att varje användare bara når sina egna rader. Det går att köra igen utan att något försvinner, och det ersätter tabellerna från den tidigare krypterade versionen om den har körts.
2. **Skapa användarens konto.** **Authentication** → **Users** → **Add user** → **Create new user**. Fyll i e-post och lösenord och kryssa i **Auto Confirm User**.
3. **Stäng av nya registreringar.** **Authentication** → **Sign In / Providers** (eller **Providers → Email** beroende på version) → slå av **Allow new users to sign up**. Då kan ingen annan skapa konto i projektet.
4. **Slå på synken i appen.** Mer → Synk mellan telefoner → Logga in.

Adressen och den publika nyckeln står i `js/config.js`. Den publika nyckeln är gjord för att ligga i en app; det är databasreglerna som skyddar datan. Om lösenordet till kontot glöms bort byts det under Authentication → Users i Supabase.

Gratisnivån i Supabase pausar projekt som inte används på en vecka. Vid daglig användning händer det inte, och ett pausat projekt kan startas igen utan att data försvinner.

## Publicera på GitHub Pages

1. Lägg filerna i ett publikt repo på GitHub (här ligger bara koden, aldrig någon data).
2. Gå till **Settings → Pages**.
3. Under **Build and deployment**: välj **Deploy from a branch**, gren `main`, mapp `/ (root)`. Spara.
4. Efter någon minut finns appen på `https://<användarnamn>.github.io/<repo>/`.

## Installera på iPhone

1. Öppna adressen i **Safari** (inte Chrome).
2. Tryck på **Dela** → **Lägg till på hemskärmen**.
3. Öppna appen från ikonen på hemskärmen. Då fungerar den offline och iOS rensar inte datan automatiskt.

Datan på telefonen hör till appen på hemskärmen. Om appen tas bort försvinner den lokala datan; med synk påslagen hämtas den igen vid nästa inloggning.

## Påminnelse varje kväll

Webbappen kan inte skicka egna notiser. Använd i stället Genvägar:

1. Öppna **Genvägar** → **Automatisering** → **+** → **Tid på dygnet**.
2. Välj tid (t.ex. 21:00), **Dagligen**, och **Kör omedelbart**.
3. Lägg till åtgärden **Öppna app** och välj **Dagbok**.

## Uppdatera appen

Höj `VERSION` i `sw.js` vid varje ändring. Telefonen hämtar då de nya filerna nästa gång appen öppnas med uppkoppling (ibland krävs att appen stängs och öppnas igen).

## Filer

| Fil | Innehåll |
|---|---|
| `index.html` | Skal, flikar, säkerhetspolicy |
| `css/app.css` | Utseende, ljust och mörkt läge |
| `js/app.js` | Vyer, incheckning, mediciner, analysvy, export/import |
| `js/analysis.js` | Beräkningar: samband, veckosnitt, före/efter |
| `js/charts.js` | SVG-grafer |
| `js/util.js` | Datum- och textfunktioner |
| `js/db.js` | Lokal lagring i IndexedDB |
| `js/sync.js` | Synk: inloggning, skicka och hämta ändringar |
| `js/config.js` | Supabase-adress och publik nyckel |
| `supabase/setup.sql` | Tabeller, radsäkerhet och funktioner för Supabase |
| `sw.js` | Offlinestöd |
| `manifest.webmanifest`, `icons/` | Hemskärmsikon och appnamn |

## Kommande etapper

- Import från Apple Hälsa via Genvägar (sömn, vilopuls, HRV, steg, träningspass) och labbvärden
- Rapport till läkarbesök (PDF), PIN-lås
