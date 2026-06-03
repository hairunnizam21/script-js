# Suzu-JS 🐉

**All-in-one Telegram AI bot for Android APK reverse-engineering.** A Node.js
rewrite of [`script_ai_panel`](https://github.com/hairunnizam21/script_ai_panel)
— one command installs everything and runs on **Termux** *and* on a **Linux
server**.

- 🤖 **Telegram bot** with a professional, Kali-flavoured UI (banner + inline
  menu + live "thinking" animation).
- 🧠 **Persistent chat memory** per user — the AI stays on topic across
  restarts and old messages.
- 🗂️ **Per-user database** — every user gets their own folder: `chat/`, `apk/`,
  `files/`.
- 📥 **Download anywhere** — files ≤ 20 MB are sent straight in the chat; larger
  files are served via a built-in download link or **SFTP**.
- 🔧 **Full APK toolchain** — decompile, recompile, modify, build, sign and
  analyse APKs of **every** framework (Java/Kotlin, Flutter, React Native,
  Unity, Xamarin, native). Works with **any** of the AI models.
- 🔌 **Universal / custom API** — point it at any OpenAI-compatible endpoint;
  change the base URL / key / model any time (`suzu config`, or `/setapi` &
  `/model` in chat). No request or token limits.
- ⚡ **Zero npm dependencies** — pure Node.js stdlib, so install is fast and
  reliable on a phone or a server.

---

## 🚀 Cara Install (satu perintah)

### Termux (Android) atau Server (Ubuntu/Debian)

```bash
curl -fsSL https://raw.githubusercontent.com/hairunnizam21/script-js/main/install.sh | bash
```

> Di server bukan-root, pastikan `sudo` tersedia. Di Termux tidak perlu root.

Installer akan **mengesan** Termux vs server secara automatik dan memasang:
Node.js (≥18), OpenJDK 17, `apktool`, `aapt`/`aapt2`, `zipalign`, `apksigner`,
`jadx`, `dex2jar`, `unzip/zip`, `file`, `binutils`, `openssh` (untuk SFTP),
serta **menjana debug keystore** dan memasang perintah `suzu`.

### Atau klon manual

```bash
git clone https://github.com/hairunnizam21/script-js.git
cd script-js
bash install.sh
```

---

## ⚙️ Konfigurasi

Jalankan wizard (boleh diulang bila-bila masa):

```bash
suzu config
```

Anda akan diminta:

| Soalan | Contoh |
|---|---|
| Telegram Bot Token | dari [@BotFather](https://t.me/BotFather) |
| AI Base URL | `https://api.cybersecdev.cloud/v1` |
| AI API Key | `fiq-xxxxxxxx` |
| Model default | `fiq/qwen3.6-plus` |
| Telegram user ID dibenarkan | kosong = semua |

Semua tersimpan di `~/.suzu-js/.env` (lihat [`.env.example`](.env.example)).
**API bersifat universal** — kalau URL berubah, cukup `suzu config` semula atau
guna `/setapi <url> [key]` terus dari Telegram.

---

## ▶️ Menjalankan

```bash
suzu start      # jalankan bot di LATAR BELAKANG (Termux: + wake-lock)
suzu status     # lihat status (banner Kali)
suzu logs -f    # ikut log langsung
suzu stop       # hentikan
suzu run        # jalankan di foreground (Ctrl-C untuk berhenti)
suzu models     # senarai model AI dari API anda
```

### Termux — run in background
`suzu start` menjalankan bot di belakang dengan `nohup` + PID file dan
mengaktifkan `termux-wake-lock` supaya terus hidup selagi Termux dibuka.
`suzu stop` akan melepaskan wake-lock.

### Server — on/off + autostart (systemd)
```bash
# salin unit (sesuaikan path bila perlu)
cp ~/script-js/systemd/suzu-bot.service /etc/systemd/system/suzu-bot@.service
systemctl daemon-reload
systemctl enable --now suzu-bot@$USER
systemctl status suzu-bot@$USER
```
Atau cukup guna `suzu start` / `suzu stop`.

---

## 💬 Guna di Telegram

1. Tekan **Start** → banner + menu muncul.
2. **Pilih Model** → tekan butang untuk memilih model AI (senarai diambil
   automatik dari API anda; model vision ditanda 👁).
3. Hantar **APK** → pilih tindakan: **Analisis / Decompile / Build / Modifikasi**.
4. Hantar **fail apa saja** (txt, gambar, zip…) → AI boleh membaca & memproses.
5. Berbual biasa — AI ada **memori** dan **tiada had**.

### Perintah
| Perintah | Fungsi |
|---|---|
| `/start` | banner + menu |
| `/model [nama]` | pilih model (tanpa argumen = menu butang) |
| `/status` | model & API semasa |
| `/files` | senarai fail anda (apk/ & files/) |
| `/download` | pautan muat turun semua fail anda |
| `/sftp` | maklumat akses SFTP |
| `/reset`, `/new` | kosongkan memori chat |
| `/setapi <url> [key]` | tukar API (admin) |
| `/help` | bantuan |

---

## 📦 Database per-user

Setiap user Telegram mendapat folder sendiri:

```
~/.suzu-js/users/<TelegramID>/
├── meta.json        info user + token download
├── chat/
│   └── session.json memori chat (sentiasa disimpan)
├── apk/             semua APK (upload + hasil build)
└── files/           semua fail lain (txt, gambar, dll)
```

### Muat turun fail
- **≤ 20 MB** → dihantar terus dalam chat Telegram.
- **> 20 MB** (lazim di server, boleh ratusan MB) → bot beri **pautan
  download** + path **SFTP**.

**Pautan HTTP:** server fail terbina dalam (port `8088` lalai). Setiap user ada
token peribadi. Untuk akses dari luar (domain), set `SUZU_PUBLIC_URL`, mis.
`SUZU_PUBLIC_URL=https://re.example.com`.

**SFTP:** semua fail ada di cakera, jadi boleh terus diakses:
```bash
sftp user@your-server        # kemudian: cd ~/.suzu-js/users/<id>
# Termux:
pkg install openssh && sshd  # port lalai 8022
```

---

## 🔧 Tetapan lanjut (`.env`)

| Kunci | Lalai | Keterangan |
|---|---|---|
| `AI_API_BASE_URL` | `https://api.cybersecdev.cloud/v1` | endpoint OpenAI-compatible |
| `AI_API_KEY` | — | kunci API |
| `AI_DEFAULT_MODEL` | `fiq/qwen3.6-plus` | model lalai |
| `TELEGRAM_BOT_TOKEN` | — | token bot |
| `TELEGRAM_ALLOWED_USER_IDS` | kosong | had akses (kosong = semua) |
| `TELEGRAM_ADMIN_USER_IDS` | kosong | siapa boleh `/setapi` |
| `SUZU_HTTP_ENABLE` | `1` | hidupkan server download |
| `SUZU_HTTP_PORT` | `8088` | port server download |
| `SUZU_PUBLIC_URL` | kosong | base URL awam untuk pautan |
| `SUZU_TG_SEND_LIMIT_MB` | `20` | had hantar fail dalam chat |
| `SUZU_ENABLE_VISION` | `1` | hantar gambar ke model vision |
| `SUZU_DATA_DIR` | `~/.suzu-js` | lokasi data |

---

## 🧰 Tools yang tersedia untuk AI
`shell`, `exec`, `read_file`, `write_file`, `edit_file`, `list_dir`, `glob`,
`grep`, `mkdir`, `move`, `remove`, `detect_apk_type`, `apk_decompile`,
`apk_recompile`, `apk_zipalign`, `apk_sign`, `apk_verify_signature`,
`apk_aapt_dump`, `apk_build_full`, `jadx_decompile`, `dex2jar`, `strings`,
`hexdump`, `file_type`, `detect_project`, `build_project`, `deliver`.

---

## ❓ Troubleshooting
- **`suzu: command not found`** → guna `node ~/script-js/bin/suzu <cmd>` atau
  pastikan `$BIN_DIR` ada dalam `PATH`.
- **Bot tak balas** → semak `suzu logs -f`, pastikan token & API key betul
  (`suzu status`).
- **APK gagal sign** → pastikan keystore wujud di `~/.suzu-js/keystores/` (dibuat
  oleh installer; perlu JDK).
- **Pautan download tak boleh dibuka dari luar** → set `SUZU_PUBLIC_URL` dan buka
  port `SUZU_HTTP_PORT`.

---

## Lesen
MIT.
