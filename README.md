# ⚡ Neon Hunt - Multiplayer Cyberpunk Arena

![Next.js](https://img.shields.io/badge/Next.js-000000?style=for-the-badge&logo=nextdotjs)
![Socket.io](https://img.shields.io/badge/Socket.io-black?style=for-the-badge&logo=socket.io)
![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript)
![TailwindCSS](https://img.shields.io/badge/TailwindCSS-38B2AC?style=for-the-badge&logo=tailwind-css)
![Realtime](https://img.shields.io/badge/Realtime-Multiplayer-green?style=for-the-badge)

---

## 🚀 Overview

**Neon Hunt** is a real-time multiplayer cyberpunk arena game built using **Next.js, Socket.io, and TypeScript**.

It delivers a **low-latency, server-authoritative multiplayer experience** with synchronized gameplay, real-time movement, and competitive scoring.

---

## 🌐 Deployment

- 🚀 **Live Demo (Vercel):** https://multiplayer-neon-hunt.vercel.app/
- 💻 **GitHub Repository:** https://github.com/siddhipawar424/multiplayer-neon-hunt

---

## 📸 UI Preview

### 🏠 Landing
![Landing](client/public/screen1.png)

### 🎮 Add Players
![Landing](client/public/screen2.png)

### 🎮 Gameplay
![Gameplay](client/public/screen3.png)

### 🏁 Results
![Results](client/public/screen4.png)

---

## ✨ Features

- ⚡ Real-time multiplayer gameplay (Socket.io)
- 🧠 Server-authoritative game logic
- 🎯 Room-based matchmaking system
- 🕹️ Smooth directional movement system
- 🏆 Live leaderboard & scoring system
- ❄️ Power-ups system (freeze, speed, shield, etc.)
- 💬 In-game real-time chat
- 📱 Mobile-friendly D-pad controls
- 🔊 Procedural sound engine
- 🎨 Cyberpunk neon UI with animations

---

## 🧠 Tech Stack

- Next.js (App Router)
- React.js
- TypeScript
- Socket.io (WebSockets)
- Node.js + Express.js
- Tailwind CSS
- Framer Motion

---

## 📂 Project Structure

Neon-Hunt/
│
├── client/
│   ├── app/
│   ├── public/
│   ├── components/
│   ├── styles/
│   └── next.config.js
│
├── server/
│   ├── server.js
│   ├── package.json
│   └── .env (NOT pushed)
│
├── .gitignore
└── README.md

---

## ⚙️ How It Works

1. Player joins or creates a room  
2. Server assigns slot + syncs game state  
3. Real-time movement via WebSocket events  
4. Server validates all actions  
5. Game state broadcast to all clients  
6. Winner computed from final score  

---

## 💡 Highlights

- Real-time distributed architecture
- Server-controlled gameplay loop
- Low-latency multiplayer sync
- Modular game engine design
- Scalable room-based system

---

## 👩‍💻 Author

Siddhi Pawar

---

## ⭐ Support

If you like this project, give it a ⭐ on GitHub.
