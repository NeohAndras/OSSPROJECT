# OSSPROJECT

## Deploy (Firebase Hosting)

### 1) Install Firebase tools
```bash
npm i -g firebase-tools
```

### 2) Login
```bash
firebase login
```

### 3) Deploy Hosting from this folder
This uses `firebase.json` (Hosting `public: "."`) so your local `MEDIA/` folder gets uploaded too.
```bash
firebase deploy --only hosting
```

## Notes
- `MEDIA/` is **ignored by GitHub** (see `.gitignore`) so the repo stays “code only”.
- Firebase Hosting uploads `MEDIA/` during deploy from your local machine.
