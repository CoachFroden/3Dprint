# 3Dprint Control Center

En lokal webapp for å styre en 3D-printer gjennom OctoPrint fra PC, mobil eller nettbrett på hjemmenettverket.

Bygget for oppsettet:

**Google Drive → 3Dprint Control Center → lokal kopi → OctoPrint → USB → Creality CR-10S Pro**

## Dette er med i første versjon

- Mørkt, responsivt kontrollpanel til PC og mobil
- Live status fra OctoPrint
- Aktiv jobb med progresjon, brukt tid og estimert tid igjen
- Start, pause, fortsett og avbryt print
- Nødstopp med ekstra bekreftelse
- Dyse- og bedtemperatur
- PLA- og PETG-hurtigvalg
- Home X/Y/Z og manuell jog av aksene
- Ekstruder/retract
- Delevifte 0–100 %
- G-code-terminal
- Google Drive-filbrowser
- Valgt Drive-fil lastes først ned lokalt på printserver-PC-en
- G-code sendes deretter til OctoPrint og kan printes uten videre avhengighet av Google Drive
- Lokal filbank på printserveren
- Dra-og-slipp lokal G-code
- Kameraområde og live stream-proxy klar for webcam når kamera blir koblet til
- PWA/webapp-shell som kan installeres på mobil

## Arkitektur

```text
Kontor-PC / mobil
       │
       │ LAN / Wi-Fi
       ▼
3Dprint Control Center (Node.js)
       │
       ├── Google Drive API
       │      └── laster valgt fil til data/downloads
       │
       ├── OctoPrint REST API
       │      └── jobb, temperatur, akser, G-code, filer
       │
       └── Kamera proxy
              │
              ▼
          OctoPrint
              │ USB
              ▼
        Creality CR-10S Pro
```

## Krav på printserver-PC-en

- Node.js 20 eller nyere
- OctoPrint installert og kjørende
- CR-10S Pro koblet til PC-en med USB
- PC-en må ikke gå i hvilemodus mens en print kjører

## Start appen

```bash
npm install
npm start
```

Åpne deretter:

```text
http://localhost:3030
```

Fra en annen enhet på samme nettverk bruker du IP-adressen til printserver-PC-en, for eksempel:

```text
http://192.168.1.50:3030
```

## Koble til OctoPrint

1. Åpne **Innstillinger** i 3Dprint.
2. Sett OctoPrint URL. Standard er `http://127.0.0.1:5000`.
3. Lim inn en OctoPrint API key.
4. Trykk **Lagre innstillinger**.
5. Trykk **Test OctoPrint**.

Appen bruker OctoPrint som den kritiske printmotoren. Den sender ikke G-code direkte til USB-porten selv.

## Google Drive

Appen bruker Drive kun til å finne og hente filer. Når du velger en fil blir den lastet ned til `data/downloads` før den sendes til OctoPrint.

Opprett gjerne en Drive-mappe som:

```text
3D-print/
└── Klar til print/
```

For direkte Drive API-tilgang trenger appen en Google OAuth-klient:

1. Opprett et prosjekt i Google Cloud Console.
2. Aktiver Google Drive API.
3. Opprett OAuth credentials av typen **Web application**.
4. Legg til redirect URI:
   `http://localhost:3030/oauth2callback`
5. Kopier Client ID og Client Secret inn under **Innstillinger**.
6. Finn folder ID fra URL-en til Drive-mappen og lim den inn i **Drive Folder ID**.
7. Lagre og trykk **Koble til Drive**.

Første OAuth-tilkobling gjøres enklest fra nettleseren på printserver-PC-en via `localhost`.

Google-token og lokale hemmeligheter lagres bare i `data/` på printserver-PC-en og er ignorert av Git.

## Kamera

Når OctoPrint har en fungerende webcam-stream forsøker appen som standard å bruke:

```text
http://127.0.0.1:5000/webcam/?action=stream
```

Hvis kameraet bruker en annen URL, legg den inn under **Innstillinger → Kamera stream URL**.

Videostrømmen proxes gjennom 3Dprint-serveren, slik at den kan vises fra andre enheter på lokalnettet.

## Sikkerhet

Denne versjonen er laget for **lokalnettet**, ikke for å eksponeres direkte mot internett. Ikke port-forward port 3030 eller OctoPrint til internett. Bruk VPN/Tailscale hvis ekstern tilgang legges til senere.

`M112` brukes til nødstopp og krever eksplisitt bekreftelse i grensesnittet.

## Lokal data

Disse filene blir ikke lagt i GitHub:

- `data/config.json`
- `data/google-token.json`
- `data/downloads/*`
- `data/tmp/*`
- `.env`

## Neste naturlige steg

- Graf for temperaturhistorikk
- Hente terminalrespons i sanntid fra OctoPrint websocket
- Kamera snapshot/timelapse
- Varsling ved ferdig print eller feil
- Bed-leveling-side tilpasset CR-10S Pro
- Filhistorikk og printstatistikk
- Automatisk start av serveren ved Windows-oppstart
