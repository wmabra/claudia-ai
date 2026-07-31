import "dotenv/config";
import { createServer } from "http";
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { WebSocketServer } from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8787;

// ──────────────────────────────────────────────
// Knowledge base
// ──────────────────────────────────────────────
// ── Knowledge base with retrieval ──
let knowledgeSections = [];
const rawPath = resolve(__dirname, "knowledge", "claudia_raw.txt");

function loadKnowledge() {
	knowledgeSections = [];
	if (existsSync(rawPath)) {
		const raw = readFileSync(rawPath, "utf8");
		// Split by document markers
		const docs = raw.split(/\n--- /).filter(Boolean);
		for (const doc of docs) {
			const newline = doc.indexOf("\n");
			const title = doc.slice(0, newline).trim().replace(/^--- /, "");
			const content = doc.slice(newline + 1).trim();
			if (content.length > 50) {
				// Further split large docs into chunks
				if (content.length > 4000) {
					const paragraphs = content.split(/\n\n+/);
					let chunk = "";
					for (const p of paragraphs) {
						if ((chunk + p).length > 4000 && chunk) {
							knowledgeSections.push({ title, content: chunk.trim() });
							chunk = p;
						} else {
							chunk += (chunk ? "\n\n" : "") + p;
						}
					}
					if (chunk) knowledgeSections.push({ title, content: chunk.trim() });
				} else {
					knowledgeSections.push({ title, content });
				}
			}
		}
		console.log(`Knowledge loaded: ${knowledgeSections.length} sections`);
	}
}

function searchKnowledge(query) {
	if (!knowledgeSections.length) return "";
	const terms = query
		.toLowerCase()
		.split(/\s+/)
		.filter((t) => t.length > 2);
	if (!terms.length) return "";

	const scored = knowledgeSections.map((s, i) => {
		const text = (s.title + " " + s.content).toLowerCase();
		let score = 0;
		for (const term of terms) {
			const count = (
				text.match(
					new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"),
				) || []
			).length;
			score += count;
			if (s.title.toLowerCase().includes(term)) score += 5; // title match bonus
		}
		return { i, score };
	});

	scored.sort((a, b) => b.score - a.score);
	const top = scored.slice(0, 3).filter((s) => s.score > 0);
	if (!top.length) return "";

	return top
		.map((s) => {
			const sec = knowledgeSections[s.i];
			return `[${sec.title}]\n${sec.content}`;
		})
		.join("\n\n---\n\n");
}
loadKnowledge();

// ──────────────────────────────────────────────
// System prompt (all Spanish)
// ──────────────────────────────────────────────
const SYSTEM_PROMPT = `Eres Claudia, una mentora profesional de aplicación mental y desarrollo personal. Hablas exclusivamente en español con un tono cálido, empático y profesional.

## Tu Personalidad
- Eres cercana, comprensiva y genuinamente interesada en ayudar a las personas
- Hablas con naturalidad, como en una conversación real — no como un robot
- Escuchas atentamente antes de responder
- Haces preguntas para profundizar cuando es apropiado
- Mantienes un tono positivo y alentador sin ser superficial
- Tus respuestas son concisas y prácticas — la gente está hablando contigo, no leyendo un libro

## Tu Conocimiento
Eres Claudia Mabra, Maestra Certificada en el Método Aplicación Mental, Conferencista Internacional, con especialidades en Diagnóstico Mental de la Salud, Definición de carácter en base a la fisionomía, y Salud Mental para Atletas de alto rendimiento. Tienes un Diplomado en Educación Financiera, Certificación en Diseño de Cursos, formación en Mindfulness, y completaste el Intensive & Progressive Course de Joe Dispenza.

Tu metodología principal es el Método de Aplicación Mental, que enseña que los pensamientos crean realidad y que los bloqueos mentales son patrones de pensamiento inconscientes que limitan el potencial. Trabajas con técnicas de reprogramación mental, diagnóstico mental cuerpo-mente, y desarrollo de la consciencia.

Cuando alguien te pregunta algo específico sobre tu metodología, recibirás información relevante de tu conocimiento para responder con precisión.

## Reglas Importantes
- SIEMPRE responde en español
- Si alguien te pregunta algo fuera de tu área (medicina, finanzas, legal), redirige amablemente indicando que no es tu especialidad
- No inventes credenciales que no tengas
- Si no sabes algo, dilo con honestidad
- Mantén la conversación enfocada en crecimiento personal y aplicación mental
- Sé cálida pero profesional — eres una mentora, no una amiga informal
- Respuestas breves (2-4 oraciones) a menos que te pidan profundizar`;

// ──────────────────────────────────────────────
// Deepgram STT
// ──────────────────────────────────────────────
async function transcribeAudio(audioBuffer) {
	const apiKey = process.env.DEEPGRAM_API_KEY;
	if (!apiKey) throw new Error("DEEPGRAM_API_KEY not set");

	const resp = await fetch(
		"https://api.deepgram.com/v1/listen?model=nova-2&language=es&smart_format=true&punctuate=true",
		{
			method: "POST",
			headers: {
				Authorization: `Token ${apiKey}`,
				"Content-Type": "audio/webm",
			},
			body: audioBuffer,
		},
	);

	if (!resp.ok) {
		const err = await resp.text();
		throw new Error(`Deepgram error ${resp.status}: ${err}`);
	}

	const json = await resp.json();
	const text = json.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
	return text.trim();
}

// ──────────────────────────────────────────────
// DeepSeek LLM (with thinking)
// ──────────────────────────────────────────────
async function getLLMResponse(conversationHistory, userMessage) {
	const apiKey = process.env.DEEPSEEK_API_KEY;
	if (!apiKey) throw new Error("DEEPSEEK_API_KEY not set");

	// Search knowledge base for relevant context
	const relevantKnowledge = searchKnowledge(userMessage);
	const systemWithContext = relevantKnowledge
		? SYSTEM_PROMPT +
			"\n\n## Información Relevante de tu Conocimiento\n" +
			relevantKnowledge
		: SYSTEM_PROMPT;

	const messages = [
		{ role: "system", content: systemWithContext },
		...conversationHistory.slice(-10), // keep last 10 exchanges
		{ role: "user", content: userMessage },
	];

	const resp = await fetch("https://api.deepseek.com/chat/completions", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model: "deepseek-reasoner",
			messages,
			max_tokens: 500,
			temperature: 0.7,
		}),
	});

	if (!resp.ok) {
		const err = await resp.text();
		throw new Error(`DeepSeek error ${resp.status}: ${err}`);
	}

	const json = await resp.json();
	const content = json.choices?.[0]?.message?.content || "";
	return content.trim();
}

// ──────────────────────────────────────────────
// ElevenLabs TTS (cloned voice)
// ──────────────────────────────────────────────
async function synthesizeSpeech(text) {
	const apiKey = process.env.ELEVENLABS_API_KEY;
	const voiceId = process.env.ELEVENLABS_VOICE_ID;
	if (!apiKey) throw new Error("ELEVENLABS_API_KEY not set");
	if (!voiceId) throw new Error("ELEVENLABS_VOICE_ID not set");

	const resp = await fetch(
		`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`,
		{
			method: "POST",
			headers: {
				"xi-api-key": apiKey,
				"Content-Type": "application/json",
				Accept: "audio/mpeg",
			},
			body: JSON.stringify({
				text,
				model_id: "eleven_multilingual_v2",
				voice_settings: {
					stability: 0.5,
					similarity_boost: 0.75,
					speed: 1.0,
				},
			}),
		},
	);

	if (!resp.ok) {
		const err = await resp.text();
		throw new Error(`ElevenLabs error ${resp.status}: ${err}`);
	}

	const arrayBuffer = await resp.arrayBuffer();
	return Buffer.from(arrayBuffer);
}

// ──────────────────────────────────────────────
// HTTP server (serves the orb page)
// ──────────────────────────────────────────────
const mimeTypes = {
	".html": "text/html",
	".js": "text/javascript",
	".css": "text/css",
	".png": "image/png",
	".svg": "image/svg+xml",
	".mp3": "audio/mpeg",
	".wav": "audio/wav",
};

const httpServer = createServer((req, res) => {
	const url = new URL(req.url, `http://localhost:${PORT}`);
	const pathname = url.pathname === "/" ? "/index.html" : url.pathname;

	// Health check for Render
	if (pathname === "/health") {
		res.writeHead(200, { "Content-Type": "application/json" });
		return res.end(JSON.stringify({ status: "ok" }));
	}

	// Reload knowledge without restart
	if (pathname === "/reload-knowledge") {
		loadKnowledge();
		res.writeHead(200, { "Content-Type": "application/json" });
		return res.end(JSON.stringify({ ok: true, size: knowledgeText.length }));
	}

	const filePath = resolve(__dirname, "public", pathname.slice(1));

	if (!existsSync(filePath)) {
		res.writeHead(404);
		return res.end("Not found");
	}

	const ext = "." + filePath.split(".").pop();
	const mime = mimeTypes[ext] || "application/octet-stream";

	// Cache busting for audio files
	const cacheControl =
		ext === ".mp3" || ext === ".wav" ? "no-cache" : "public, max-age=3600";

	res.writeHead(200, {
		"Content-Type": mime,
		"Cache-Control": cacheControl,
	});
	res.end(readFileSync(filePath));
});

// ──────────────────────────────────────────────
// WebSocket server (real-time conversation)
// ──────────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (ws) => {
	console.log("Client connected");

	// Per-session conversation history
	const history = [];

	// Send initial status
	ws.send(JSON.stringify({ type: "status", state: "idle" }));

	ws.on("message", async (raw) => {
		let msg;
		try {
			msg = JSON.parse(raw.toString());
		} catch {
			return;
		}

		if (msg.type === "ping") {
			ws.send(JSON.stringify({ type: "pong" }));
			return;
		}

		if (msg.type === "audio") {
			try {
				// 1) Status: transcribing
				ws.send(JSON.stringify({ type: "status", state: "listening" }));

				// Decode base64 audio
				const audioBuffer = Buffer.from(msg.data, "base64");

				// 2) Transcribe
				const transcript = await transcribeAudio(audioBuffer);
				console.log("Transcript:", transcript);

				if (!transcript) {
					ws.send(
						JSON.stringify({
							type: "status",
							state: "idle",
							text: "No te escuché bien, ¿podrías repetirlo?",
						}),
					);
					return;
				}

				// Send transcript back so UI can show it
				ws.send(
					JSON.stringify({ type: "text", role: "user", content: transcript }),
				);

				// 3) Status: thinking
				ws.send(JSON.stringify({ type: "status", state: "thinking" }));

				// 4) Get LLM response
				const response = await getLLMResponse(history, transcript);
				console.log("Claudia:", response);

				// Save to history
				history.push({ role: "user", content: transcript });
				history.push({ role: "assistant", content: response });

				// Send text response
				ws.send(
					JSON.stringify({
						type: "text",
						role: "assistant",
						content: response,
					}),
				);

				// 5) Status: speaking
				ws.send(JSON.stringify({ type: "status", state: "speaking" }));

				// 6) Synthesize speech
				const audioData = await synthesizeSpeech(response);
				const audioBase64 = audioData.toString("base64");

				// 7) Send audio to client
				ws.send(
					JSON.stringify({
						type: "audio",
						data: audioBase64,
						mime: "audio/mpeg",
					}),
				);

				// 8) Done
				ws.send(JSON.stringify({ type: "status", state: "idle" }));
			} catch (err) {
				console.error("Pipeline error:", err);
				ws.send(JSON.stringify({ type: "error", message: err.message }));
				ws.send(JSON.stringify({ type: "status", state: "idle" }));
			}
		}
	});

	ws.on("close", () => {
		console.log("Client disconnected");
	});
});

// ──────────────────────────────────────────────
// Start
// ──────────────────────────────────────────────
httpServer.listen(PORT, () => {
	console.log(`\n  🧠 Claudia AI — Aplicación Mental\n`);
	console.log(`  Server:  http://localhost:${PORT}`);
	console.log(
		`  Config:  ${process.env.DEEPSEEK_API_KEY ? "✅ DeepSeek" : "❌ DeepSeek"}`,
	);
	console.log(
		`           ${process.env.DEEPGRAM_API_KEY ? "✅ Deepgram" : "❌ Deepgram"}`,
	);
	console.log(
		`           ${process.env.ELEVENLABS_API_KEY ? "✅ ElevenLabs" : "❌ ElevenLabs"}\n`,
	);
});
