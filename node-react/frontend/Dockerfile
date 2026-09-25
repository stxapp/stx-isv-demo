# Vite + React frontend.
#
# Runs the Vite dev server so VITE_* env vars are read at container start (no
# rebuild needed to repoint the backend/WS URLs). For a production build you
# would instead `npm run build` and serve the static `dist/` (e.g. from the
# backend or a CDN): see the note in docker-compose.yml.
FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install

COPY . .

EXPOSE 5173

CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]
