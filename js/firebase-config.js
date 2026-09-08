/* ============================================================
   firebase-config.js — the one thing you have to fill in

   Rooms need somewhere to hold a game while it is being played.
   Create a free Firebase project, turn on the Realtime Database,
   and paste its URL here.

   See "Setting up the database" in README.md for the steps,
   including the rules to paste in.
   ============================================================ */
export const DATABASE_URL = 'https://imposter-app-game-default-rtdb.firebaseio.com';

/* Everything this app stores lives under this one key, so it can share a
   database with another game without the two ever meeting. */
export const ROOT = 'fivecrowns';
