# Live Translation Customer Support 🌐⚡

Un'applicazione per il Customer Support in tempo reale ad altissima fedeltà e a bassissima latenza, che sfrutta la nuovissima **Gemini Multimodal Live API (`models/gemini-3.5-live-translate-preview`)** per offrire una traduzione vocale bidirezionale istantanea.

L'applicazione cattura la voce dell'operatore o del cliente in italiano, la trasmette tramite streaming binario continuo PCM a un server proxy Node.js/Express, che stabilisce una connessione WebSocket persistente con l'infrastruttura Google ed esegue la sintesi vocale e testuale tradotta quasi istantaneamente nella lingua desiderata.

---

## 🚀 Stack Tecnologico

1. **Frontend**:
   - **React 19** con TypeScript.
   - **Tailwind CSS** per un'interfaccia utente scura, elegante, pulita e professionale.
   - **Framer Motion** per micro-animazioni fluide ed effetti dinamici delle onde sonore.
   - **AudioContext API**:
     - *Input*: Cattura l'audio del microfono dell'utente, eseguendone il downsampling a 16kHz mono (formato atteso da Gemini) e lo invia in tempo reale sotto forma di pacchetti PCM a 16-bit tramite WebSocket.
     - *Output*: Riceve lo stream della risposta vocale di Gemini a 24kHz, lo decodifica dinamicamente e lo riproduce in sequenza programmata ad altissima precisione senza interruzioni.

2. **Backend**:
   - **Node.js** con l'ultimo framework **Express**.
   - **WebSocket (ws)**: Gestisce una connessione locale duplex tra client e server, agendo da proxy sicuro verso il server ufficiale Google Generative Service. Questo protegge la chiave API lato server mantenendola invisibile al browser.
   - **Esbuild / tsx**: Strumenti di bundling e compilazione ultra-veloci per permettere l'esecuzione diretta del backend TypeScript in ambiente di sviluppo e produzione.

---

## 🛠️ Funzionalità Sviluppate

* **Traduzione Bidirezionale Istantanea**: Traduzione voce-a-voce da Italiano a molteplici lingue selezionabili con una latenza ridotta al minimo assoluto (< 100ms di elaborazione locale).
* **Selettore della Lingua di Destinazione**: Scegli tra diverse lingue di arrivo (Inglese, Spagnolo, Francese, Tedesco, Portoghese, Russo, Cinese, Giapponese) con aggiornamento dinamico immediato della sessione e delle istruzioni di sistema per Gemini.
* **Sottotitoli Testuali in Tempo Reale**: Mostra a schermo la trascrizione in tempo reale della traduzione simultanea dell'AI per un supporto visuale immediato del testo tradotto.
* **Monitoraggio Livelli Audio Real-Time**: Misurazione automatica del valore RMS per visualizzare il livello del proprio microfono e il feedback di output di Gemini tramite barre di volume animate.
* **Controllo Microfono (Mute/Unmute)**: Possibilità di silenziare temporaneamente il microfono durante la chiamata attiva per consentire privacy o pause nell'assistenza.
* **Storico Sotto-sessioni Recenti**: Salvataggio in `localStorage` delle ultime 5 sessioni effettuate con dettagli sulla lingua usata e numero di interazioni tradotte.
* **Annullamento Deriva (Buffer Resync)**: Algoritmo intelligente nel player audio per risincronizzare l'AudioContext in caso di accumulazione di latenza dovuta a jitter di rete o rallentamenti del browser.

---

## ⚙️ Come Avviarlo

### Requisiti di Sistema
- **Node.js** (v18 o superiore consigliato)
- Una chiave API di Google AI Studio assegnata alla variabile `GEMINI_API_KEY`

### 1. Configura le Variabili d'Ambiente
Crea o modifica il file `.env` (puoi copiare la struttura da `.env.example`) inserendo le credenziali:
```env
GEMINI_API_KEY="LA_TUA_CHIAVE_API_GEMINI"
```

### 2. Installa le dipendenze
Installa tutti i pacchetti necessari definiti nel `package.json` eseguendo:
```bash
npm install
```

### 3. Avvia l'applicazione in modalità Sviluppo
Esegui il server di sviluppo integrato (Vite + Express Proxy):
```bash
npm run dev
```
L'applicazione sarà accessibile localmente all'indirizzo `http://localhost:3000` (o sulla porta indicata in console).

### 4. Compila per la Produzione
Per creare una build ottimizzata e bundle del server compilato:
```bash
npm run build
npm start
```
