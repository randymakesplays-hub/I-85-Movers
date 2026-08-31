# I-85 Movers

Marketing site for I-85 Movers — local, long-distance and international moving
on the I-85 corridor (Charlotte ↔ D.C. · Virginia Beach ↔ Raleigh–Durham).

## Run locally

```sh
npm start
```

Then open http://localhost:3000.

## Deploy

The site is a single static page (`index.html`) served by a zero-dependency
Node server (`server.js`). Railway (and most PaaS hosts) auto-detect the Node
app and run `npm start`, binding to `$PORT`.
