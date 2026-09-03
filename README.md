# Negotiations Agent Demo

A standalone chat demo for the "Negotiations agent" (buyer copilot) — an Automation Anywhere EKB-backed chatbot for reviewing purchase requisitions, comparing vendor bids, and working negotiation strategy.

## Run locally

1. Install [Node.js LTS](https://nodejs.org).
2. `npm install`
3. Copy `.env.example` to `.env` and fill in your EKB credentials (already done for you if `.env` is present).
4. `npm start`
5. Open http://localhost:3000 (or the `PORT` you set).

Do not open `public/index.html` directly — it has to run through the Node backend so `/api/chat` works.

## Deploy

This is a plain Node/Express app — deploy anywhere that runs Node (Render, Railway, Fly.io, etc.):

- **Build command:** `npm install`
- **Start command:** `npm start`
- **Environment variables:** everything in `.env.example`, set to your real values.
