# WhatsApp-gateway (Baileys)

Eigen vervanger voor WhatsReach in het [Paal 13 sollicitatiesysteem](https://github.com/lucasdonker/RBSollicitatie). Draait als Docker-app op de TrueNAS en spreekt precies dezelfde
API als WhatsReach (`POST /send`, `GET /devices`, header `X-API-Key`). Het sollicitatiesysteem
verandert daardoor niet: je zet alleen in het beheer een andere Base URL en API-sleutel.

```
sollicitatiesysteem (Cloud86)        TrueNAS                                         WhatsApp
cron › wa_verstuur_res() ──HTTPS──▶ Tailscale Funnel    ─▶ wa-gateway (Baileys) ──WebSocket──▶ servers ─▶ sollicitant
                                                          │
                                                          └─ /data/auth  (sessie = gekoppeld apparaat)
gateway-telefoon (prepaid sim, WhatsApp) = hoofdtoestel; de gateway is een "gekoppeld apparaat", net als WhatsApp Web
```

- Uurlimiet, pauze na fouten en terugval naar sms/e-mail blijven in het sollicitatiesysteem zitten.
- De gateway verstuurt één bericht tegelijk, met minimaal 2,5 s tussenpoos en kort "typt…".
- Heeft een nummer geen WhatsApp, dan antwoordt de gateway met een fout. Het systeem stuurt dan
  zelf een sms of e-mail.
- Antwoorden van sollicitanten komen binnen op de gateway-telefoon (de gateway leest niets).

## Eenmalig neerzetten (kan helemaal vanaf je telefoon)

1. **Image publiek maken.** Na elke push naar `main` bouwt GitHub het image
   (Actions › "WhatsApp-gateway image"). Daarna op github.com: je profiel › Packages ›
   `paal13-wa-gateway` › Package settings › Change visibility › Public. Er zit geen geheim in;
   zo hoeft de TrueNAS niet in te loggen bij GitHub.
2. **Dataset maken.** TrueNAS › Datasets › onder je pool `apps` › Add Dataset › naam
   `paal13-wa-gateway`, Dataset Preset **Apps**. Hier staan straks de WhatsApp-sessie en de
   Tailscale-gegevens.
3. **Tailscale klaarzetten** (login.tailscale.com, gratis account):
   - DNS › **MagicDNS** aan en **HTTPS Certificates** aan.
   - Settings › Keys › **Generate auth key** (niet herbruikbaar is prima). Kopieer de sleutel.
   - Je tailnet-naam staat bij DNS (iets als `tail1234.ts.net`).
4. **App installeren.** TrueNAS › Apps › Discover Apps › ⋮ › **Install via YAML**. Naam
   `paal13-wa-gateway`, plak `truenas-compose.yaml` en vul de vier `VUL_IN`-plekken in
   (auth key, koppelwachtwoord en twee keer de naam van je pool).
5. **Tailscale-apparaat vastzetten.** In login.tailscale.com › Machines staat nu `paal13-wa`.
   ⋯ › **Disable key expiry**, anders valt de verbinding na een half jaar weg. Werkt Funnel niet
   (adres onbereikbaar)? Access controls › controleer dat leden het attribuut `funnel` hebben;
   de console biedt dat zelf aan.
6. **Koppelen.** Open `https://paal13-wa.<tailnet>.ts.net/koppelen` (gebruikersnaam maakt niet
   uit, wachtwoord = `KOPPEL_WACHTWOORD`). Vul het nummer van de gateway-telefoon in › Koppelcode
   aanvragen. Op die telefoon: WhatsApp › Instellingen › Gekoppelde apparaten › Apparaat koppelen
   › Koppelen met telefoonnummer › code invoeren. Of scan de QR-code vanaf een ander scherm.
   De eerste keer kan het adres een halve minuut duren: Tailscale vraagt dan het certificaat aan.
7. **Sollicitatiesysteem omzetten.** Beheer › Instellingen › Kanalen › WhatsApp: API-sleutel = de
   sleutel van de koppelpagina, Base URL = `https://paal13-wa.<tailnet>.ts.net`, afzendernummer
   leeg. Opslaan en onderaan een testbericht sturen.

Bijwerken: na een push naar `main` staat er een nieuw `:latest`-image klaar; werk de app in
TrueNAS › Apps bij (Update, of Edit › Save om het image opnieuw op te halen).

## De gateway-telefoon en de 14-dagenregel

WhatsApp koppelt een gekoppeld apparaat los als het **hoofdtoestel** 14 dagen niet gebruikt is.
De gateway kan dat niet zelf voorkomen; hij is zelf het gekoppelde apparaat. Dus:

- Gebruik een aparte prepaid sim in een oude telefoon die aan de lader en wifi blijft liggen.
- Open WhatsApp daarop minstens eens per week (of laat het bestuur er antwoorden mee afhandelen,
  dan gebeurt het vanzelf).
- Zet `MELDING_WEBHOOK` op een ntfy-onderwerp: dan krijg je een pushbericht als de gateway is
  uitgelogd. Tot je opnieuw koppelt gaan berichten automatisch via sms/e-mail.

## Instellingen (omgevingsvariabelen)

| Variabele | Standaard | Betekenis |
|---|---|---|
| `KOPPEL_WACHTWOORD` | — | Wachtwoord voor `/koppelen`. Leeg = pagina uit. |
| `API_SLEUTEL` | zelf gemaakt | Leeg: gateway maakt er één in `/data/api-sleutel.txt`. |
| `MELDING_WEBHOOK` | — | URL die een POST krijgt bij uitloggen/blokkade (bijv. ntfy). |
| `MIN_INTERVAL_MS` | 2500 | Minimale tijd tussen twee berichten. |
| `CONTROLEER_NUMMER` | 1 | Eerst checken of het nummer WhatsApp heeft (0 = uit). |
| `APPARAAT_NAAM` | Paal 13 sollicitaties | Naam in `/devices`. |
| `LOG_NIVEAU` | warn | Logniveau van Baileys. |

Monitoring: `GET /status` geeft 200 als WhatsApp verbonden is en anders 503 (geschikt voor
Uptime Kuma). `GET /health` geeft altijd 200 zolang het proces leeft.

## Risico

Baileys is, net als WhatsReach, geen officiële WhatsApp-koppeling. Het nummer kan geblokkeerd
worden. Gebruik daarom een apart nummer en stuur alleen naar mensen die WhatsApp-contact verwachten.
De Baileys-versie staat vast in `package.json` (7.0.0-rc14); werk die bewust bij.
