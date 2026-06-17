import express from "express";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { createServer as createViteServer } from "vite";
import { WebSocket, WebSocketServer } from "ws";
import dotenv from "dotenv";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Create an HTTP server so that Express and WS run on the same port
  const server = http.createServer(app);

  // Initialize WebSocket Server
  const wss = new WebSocketServer({ noServer: true });

  // Handle upgrade to WebSockets
  server.on("upgrade", (request, socket, head) => {
    const { pathname } = new URL(request.url || "", `http://${request.headers.host}`);
    if (pathname === "/api/live") {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  // Handle WebSocket connections
  wss.on("connection", (clientWs, request) => {
    console.log("Client websocket connected to proxy server");

    // Retrieve target language from query string safely with http://localhost base
    const urlObj = new URL(request.url || "", "http://localhost");
    const targetLangCode = urlObj.searchParams.get("lang") || "en";
    const targetLangLocalName = urlObj.searchParams.get("langName") || "Inglese";
    const targetLangEngName = urlObj.searchParams.get("langEngName") || "English";

    // Obtain Gemini API Key from environment
    const geminiApiKey = process.env.GEMINI_API_KEY;
    if (!geminiApiKey) {
      console.error("GEMINI_API_KEY is not defined in environment");
      clientWs.send(JSON.stringify({ error: "Errore: GEMINI_API_KEY non è configurata sul server." }));
      clientWs.close();
      return;
    }

    // Connect to official Google Gemini Multimodal Live API endpoint
    const geminiUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${geminiApiKey}`;
    
    console.log(`Connecting to Gemini Live API with target language: ${targetLangLocalName} / ${targetLangEngName} (${targetLangCode})`);
    const geminiWs = new WebSocket(geminiUrl);

    let isGeminiOpen = false;
    const pendingJsonMessages: string[] = [];

    geminiWs.on("open", () => {
      console.log("Connected to Gemini Live API");
      isGeminiOpen = true;

      // System instruction required directly in the setup:
      // "Traduci immediatamente l'audio dall'italiano alla lingua selezionata. Restituisci solo l'audio tradotto puro, senza preamboli"
      const systemInstructionText = `Traduci immediatamente l'audio dall'italiano alla lingua ${targetLangLocalName}. Restituisci solo l'audio tradotto puro, senza preamboli.
You are a highly efficient real-time speech-to-speech translator. Translate all input speech immediately from Italian to ${targetLangEngName} (${targetLangCode}).
Provide ONLY the translated speech/audio directly with zero latency, with absolutely no preamble, no meta-commentary, no conversational fillers (like "here is the translation"), and no translation notes. Absolute low-latency translation is the target. Always translate immediately and output only the speech/audio translation. Do not ever speak Italian.`;

      // Construct the Setup payload for BidiGenerateContent
      const setupMsg = {
        setup: {
          model: "models/gemini-3.5-live-translate-preview",
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName: "Puck" // Using 'Puck' as natural-sounding output voice
                }
              }
            }
          },
          systemInstruction: {
            parts: [
              {
                text: systemInstructionText
              }
            ]
          }
        }
      };

      geminiWs.send(JSON.stringify(setupMsg));

      // Ship any backlogged messages
      while (pendingJsonMessages.length > 0) {
        const msg = pendingJsonMessages.shift();
        if (msg) geminiWs.send(msg);
      }
    });

    geminiWs.on("message", (data) => {
      try {
        const responseText = data.toString();
        const responseJson = JSON.parse(responseText);

        let audioBase64 = "";
        let transcriptionText = "";

        // Raw BidiGenerateContent returns parts under serverContent.modelTurn.parts
        if (responseJson.serverContent?.modelTurn?.parts) {
          for (const part of responseJson.serverContent.modelTurn.parts) {
            if (part.inlineData?.data) {
              audioBase64 += part.inlineData.data;
            }
            if (part.text) {
              transcriptionText += part.text;
            }
          }
        }

        // Output transcription specifically
        if (responseJson.serverContent?.outputAudioTranscription?.text) {
          transcriptionText += responseJson.serverContent.outputAudioTranscription.text;
        }

        // Send down to client
        if (audioBase64 || transcriptionText || responseJson.serverContent?.interrupted) {
          clientWs.send(JSON.stringify({
            audio: audioBase64 || undefined,
            text: transcriptionText || undefined,
            interrupted: responseJson.serverContent?.interrupted || undefined
          }));
        }

      } catch (err) {
        console.error("Error parsing Gemini message:", err);
      }
    });

    geminiWs.on("error", (err) => {
      console.error("Gemini WebSocket error:", err);
      clientWs.send(JSON.stringify({ error: "Errore durante la comunicazione con Gemini Live." }));
    });

    geminiWs.on("close", (code, reason) => {
      console.log(`Gemini WebSocket closed: ${code} - ${reason}`);
      clientWs.close();
    });

    clientWs.on("message", (data) => {
      try {
        const parsed = JSON.parse(data.toString());

        // Standard microphone packet transmission
        if (parsed.audio) {
          const geminiInputMsg = {
            realtimeInput: {
              mediaChunks: [
                {
                  mimeType: "audio/pcm;rate=16000",
                  data: parsed.audio
                }
              ]
            }
          };

          const rawMsgString = JSON.stringify(geminiInputMsg);
          if (isGeminiOpen) {
            geminiWs.send(rawMsgString);
          } else {
            pendingJsonMessages.push(rawMsgString);
          }
        }
      } catch (err) {
        console.error("Error processing client audio packet:", err);
      }
    });

    clientWs.on("close", () => {
      console.log("Client closed connection. Closing Gemini API websocket.");
      if (geminiWs.readyState === WebSocket.OPEN || geminiWs.readyState === WebSocket.CONNECTING) {
        geminiWs.close();
      }
    });
  });

  // Serve static files in development & production
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server listening on port ${PORT}`);
  });
}

startServer();
