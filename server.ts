import express from 'express';
import path from 'path';
import dotenv from 'dotenv';
import { GoogleGenAI, Type } from '@google/genai';
import { createServer as createViteServer } from 'vite';
import { Card, OnlineRoom, Player } from './src/types';

// Load environment variables
dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json());

// Initialize Gemini SDK with telemetry User-Agent header
const apiKey = process.env.GEMINI_API_KEY;
let ai: GoogleGenAI | null = null;

if (apiKey) {
  ai = new GoogleGenAI({
    apiKey: apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
} else {
  console.warn('GEMINI_API_KEY environment variable is not defined.');
}

// In-memory store for online matchmaking lobbies
const rooms: { [code: string]: OnlineRoom } = {};

// Helper to generate a unique room code
function generateRoomCode(): string {
  let code = '';
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Avoid ambiguous chars
  do {
    code = '';
    for (let i = 0; i < 5; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
  } while (rooms[code]);
  return code;
}

// -------------------------------------------------------------
// AI API Endpoints
// -------------------------------------------------------------

// 1. Generate Custom Tabu Cards dynamically using Gemini Flash
app.post('/api/gemini/generate-card', async (req, res) => {
  const { category, difficulty } = req.body;

  if (!ai) {
    return res.status(500).json({ error: 'Gemini API is not initialized. Please set GEMINI_API_KEY in Secrets.' });
  }

  try {
    const prompt = `Yeni ve yaratıcı bir Türkçe Tabu kartı üret. 
Kategori: ${category || 'Karışık'}
Zorluk Seviyesi: ${difficulty || 'Orta'} (Kolay, Orta veya Zor seviyeye uygun bir hedef kelime seç)

Kurallar:
1. "word" (hedef kelime) Türkçe, tekil, popüler ve bulunması eğlenceli bir kelime olsun.
2. "tabooWords" (yasak kelimeler) tam olarak 5 adet olmalı. Hedef kelimeyi anlatırken akla ilk gelen, en mantıklı ve en çok kullanılan 5 kelimeyi seç.
3. Kategoriyle ve seçilen zorluk derecesiyle tam uyumlu olsun.

Yanıtı sadece şu JSON formatında ver:
{
  "word": "HEDEF_KELİME",
  "tabooWords": ["YASAK_1", "YASAK_2", "YASAK_3", "YASAK_4", "YASAK_5"],
  "category": "${category || 'Karışık'}",
  "difficulty": "${difficulty || 'Orta'}"
}`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.5-flash',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            word: { type: Type.STRING },
            tabooWords: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
              description: 'Exactly 5 taboo words related closely to the target word.'
            },
            category: { type: Type.STRING },
            difficulty: { type: Type.STRING }
          },
          required: ['word', 'tabooWords', 'category', 'difficulty']
        }
      }
    });

    const text = response.text;
    if (!text) {
      throw new Error('Empty response received from Gemini.');
    }

    const cardData = JSON.parse(text);
    // Ensure words are capitalized consistently
    cardData.word = cardData.word.toUpperCase();
    cardData.tabooWords = cardData.tabooWords.map((w: string) => w.toUpperCase());
    cardData.id = 'ai_' + Math.random().toString(36).substr(2, 9);

    res.json({ card: cardData });
  } catch (err: any) {
    console.error('Error in /api/gemini/generate-card:', err);
    res.status(500).json({ error: 'Kart üretilirken bir hata oluştu: ' + err.message });
  }
});

// 2. AI Narrator for Single Player mode - acts as the describer
app.post('/api/gemini/narrate', async (req, res) => {
  const { card, history } = req.body; // history can contain previous hints and guesses

  if (!ai) {
    return res.status(500).json({ error: 'Gemini API is not initialized.' });
  }

  try {
    const tabooWordsStr = card.tabooWords.join(', ');
    const historyStr = history && history.length > 0 
      ? `\nÖnceki ipuçları ve tahminler:\n${JSON.stringify(history)}`
      : '';

    const prompt = `Sen eğlenceli, zeki ve profesyonel bir Tabu anlatıcısısın. 
Tek oyunculu modda, aşağıdaki kelimeyi bana (oyuncuya) anlatıyorsun.

Hedef Kelime (Bunu ASLA söyleme, ima etme veya kökünü kullanma!): ${card.word}
Yasaklı Kelimeler (Bunları ASLA söyleme, ima etme veya kökünü kullanma!): ${tabooWordsStr}
Kategori: ${card.category}
${historyStr}

Görevin:
Hedef kelimeyi ve 5 yasaklı kelimeyi kesinlikle kullanmadan, Türkçe dil bilgisi kurallarına uygun, çok yaratıcı, eğlenceli ve 1-2 cümlelik harika bir ipucu üret. 
Kelimelerin harflerini heceleme, kafiyeli kelimeler verme ya da yabancı dildeki karşılığını söyleme. Doğrudan tanım veya kullanım alanı vererek anlat.

Sadece ipucunu içeren metni döndür (JSON ya da etiket ekleme, doğrudan konuşma cümlesi olsun).`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.5-flash',
      contents: prompt,
      config: {
        temperature: 0.8
      }
    });

    const hint = response.text || 'Üzgünüm, şu an kelimeyi tarif edemedim. Pas geçebilirsin!';
    res.json({ hint: hint.trim() });
  } catch (err: any) {
    console.error('Error in /api/gemini/narrate:', err);
    res.status(500).json({ error: 'Anlatıcı ipucu üretirken hata oluştu: ' + err.message });
  }
});

// -------------------------------------------------------------
// Online Room Management Endpoints (Matchmaking system)
// -------------------------------------------------------------

// Create a new room
app.post('/api/rooms/create', (req, res) => {
  const { hostName, hostId } = req.body;
  if (!hostName || !hostId) {
    return res.status(400).json({ error: 'Eksik parametreler.' });
  }

  const code = generateRoomCode();
  const host: Player = { id: hostId, name: hostName, isReady: true, score: 0 };
  
  const newRoom: OnlineRoom = {
    code,
    hostId,
    players: [host],
    status: 'lobby',
    currentRound: 1,
    maxRounds: 3,
    currentTurnPlayerId: hostId,
    currentCard: null,
    turnStartTime: null,
    turnDuration: 60,
    scores: { [hostId]: 0 },
    guesses: [],
    usedCardIds: []
  };

  rooms[code] = newRoom;
  res.json({ room: newRoom });
});

// Join an existing room via code
app.post('/api/rooms/join', (req, res) => {
  const { code, playerName, playerId } = req.body;
  if (!code || !playerName || !playerId) {
    return res.status(400).json({ error: 'Eksik parametreler.' });
  }

  const normalizedCode = code.toUpperCase().trim();
  const room = rooms[normalizedCode];

  if (!room) {
    return res.status(404).json({ error: 'Oda bulunamadı. Lütfen kodu kontrol edin.' });
  }

  if (room.status !== 'lobby') {
    return res.status(400).json({ error: 'Bu oda zaten oyuna başlamış durumda.' });
  }

  // Check if player already in room
  const exists = room.players.find(p => p.id === playerId);
  if (!exists) {
    const newPlayer: Player = { id: playerId, name: playerName, isReady: false, score: 0 };
    room.players.push(newPlayer);
    room.scores[playerId] = 0;
  }

  res.json({ room });
});

// Check room status
app.get('/api/rooms/status/:code', (req, res) => {
  const code = req.params.code.toUpperCase().trim();
  const room = rooms[code];
  if (!room) {
    return res.status(404).json({ error: 'Oda bulunamadı.' });
  }
  res.json({ room });
});

// Player sets ready status
app.post('/api/rooms/ready', (req, res) => {
  const { code, playerId, isReady } = req.body;
  const room = rooms[code?.toUpperCase()];
  if (!room) return res.status(404).json({ error: 'Oda bulunamadı.' });

  const player = room.players.find(p => p.id === playerId);
  if (player) {
    player.isReady = isReady;
  }
  res.json({ room });
});

// Host starts the game
app.post('/api/rooms/start', (req, res) => {
  const { code, hostId, initialCard, duration } = req.body;
  const room = rooms[code?.toUpperCase()];
  if (!room) return res.status(404).json({ error: 'Oda bulunamadı.' });

  if (room.hostId !== hostId) {
    return res.status(403).json({ error: 'Sadece kurucu oyunu başlatabilir.' });
  }

  room.status = 'playing';
  room.currentRound = 1;
  room.currentCard = initialCard || null;
  room.turnStartTime = Date.now();
  room.turnDuration = duration || 60;
  room.guesses = [];
  room.usedCardIds = initialCard ? [initialCard.id] : [];
  
  // Set first player turn
  room.currentTurnPlayerId = room.players[0].id;

  res.json({ room });
});

// Handle player guess submissions in real-time
app.post('/api/rooms/submit-guess', (req, res) => {
  const { code, playerId, playerName, guessText } = req.body;
  const room = rooms[code?.toUpperCase()];
  if (!room) return res.status(404).json({ error: 'Oda bulunamadı.' });

  if (room.status !== 'playing' || !room.currentCard) {
    return res.status(400).json({ error: 'Aktif bir el oynanmıyor.' });
  }

  const cleanGuess = guessText.trim().toUpperCase();
  const isCorrect = cleanGuess === room.currentCard.word.toUpperCase();

  const newGuess = {
    id: 'g_' + Math.random().toString(36).substr(2, 9),
    playerId,
    playerName,
    text: guessText,
    timestamp: Date.now(),
    isCorrect
  };

  room.guesses.push(newGuess);

  if (isCorrect) {
    // Correct guess scores points to the guesser AND the describer!
    room.scores[playerId] = (room.scores[playerId] || 0) + 10;
    room.scores[room.currentTurnPlayerId] = (room.scores[room.currentTurnPlayerId] || 0) + 10;
    
    // Update individual player models too
    const guesser = room.players.find(p => p.id === playerId);
    if (guesser) guesser.score = (guesser.score || 0) + 10;
    const describer = room.players.find(p => p.id === room.currentTurnPlayerId);
    if (describer) describer.score = (describer.score || 0) + 10;
  }

  res.json({ room, isCorrect });
});

// Host updates card during turn (next card, pass, taboo/faul)
app.post('/api/rooms/action', (req, res) => {
  const { code, playerId, actionType, nextCard } = req.body;
  const room = rooms[code?.toUpperCase()];
  if (!room) return res.status(404).json({ error: 'Oda bulunamadı.' });

  if (room.currentTurnPlayerId !== playerId) {
    return res.status(403).json({ error: 'Yalnızca anlatıcı kart aksiyonu yapabilir.' });
  }

  if (actionType === 'correct') {
    room.scores[playerId] = (room.scores[playerId] || 0) + 10;
  } else if (actionType === 'taboo') {
    room.scores[playerId] = (room.scores[playerId] || 0) - 5;
  } else if (actionType === 'pass') {
    room.scores[playerId] = (room.scores[playerId] || 0) - 1;
  }

  const player = room.players.find(p => p.id === playerId);
  if (player) {
    player.score = room.scores[playerId];
  }

  if (nextCard) {
    room.currentCard = nextCard;
    room.usedCardIds.push(nextCard.id);
  }

  res.json({ room });
});

// Switch turns to the next describer
app.post('/api/rooms/next-turn', (req, res) => {
  const { code, nextCard } = req.body;
  const room = rooms[code?.toUpperCase()];
  if (!room) return res.status(404).json({ error: 'Oda bulunamadı.' });

  // Find next player index
  const currentIndex = room.players.findIndex(p => p.id === room.currentTurnPlayerId);
  let nextIndex = currentIndex + 1;

  if (nextIndex >= room.players.length) {
    nextIndex = 0;
    room.currentRound += 1;
  }

  if (room.currentRound > room.maxRounds) {
    room.status = 'ended';
    room.currentCard = null;
    room.turnStartTime = null;
  } else {
    room.currentTurnPlayerId = room.players[nextIndex].id;
    room.currentCard = nextCard || null;
    room.turnStartTime = Date.now();
    room.guesses = [];
    if (nextCard) room.usedCardIds.push(nextCard.id);
  }

  res.json({ room });
});

// Leave room
app.post('/api/rooms/leave', (req, res) => {
  const { code, playerId } = req.body;
  const room = rooms[code?.toUpperCase()];
  if (!room) return res.status(200).json({ message: 'Oda zaten aktif değil.' });

  room.players = room.players.filter(p => p.id !== playerId);
  
  if (room.players.length === 0) {
    delete rooms[code?.toUpperCase()];
  } else if (room.hostId === playerId) {
    // Reassign host
    room.hostId = room.players[0].id;
    if (room.status === 'playing') {
      room.currentTurnPlayerId = room.hostId;
    }
  }

  res.json({ success: true });
});

// -------------------------------------------------------------
// Vite Dev Server / Production Static Serving
// -------------------------------------------------------------

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
