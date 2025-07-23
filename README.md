# BBLIP Telegram Bot

Telegram grubunda kullanıcı aktivitelerini takip eden ve XP sistemi sağlayan bot.

## Kurulum

### 1. Bot Token Alın
1. Telegram'da @BotFather'a gidin
2. `/newbot` komutunu kullanın
3. Bot adı: `BBLIP Telegram Bot`
4. Bot username: `denemebot45bot`
5. Token'ı kaydedin

### 2. Telegram Login Widget Ayarları
Bot'unuzun Login Widget'ı desteklemesi için @BotFather'da:

```
/setdomain - Bot'unuzun domain'ini ayarlayın
```

**Domain ayarları:**
- Development: `localhost:3000`
- Production: `yourdomain.com`

### 3. Environment Variables
`.env` dosyasını oluşturun:

```env
# Telegram Bot Configuration
TELEGRAM_BOT_TOKEN=your_bot_token_here
TELEGRAM_GROUP_ID=-1002823529287

# Supabase Configuration
SUPABASE_URL=your_supabase_url_here
SUPABASE_SERVICE_KEY=your_supabase_service_key_here

# Web App URL
WEB_APP_URL=http://localhost:3000

# Bot Settings
NODE_ENV=production
LOG_LEVEL=info
```

### 4. Bot'u Başlatın
```bash
npm install
npm start
```

## Bot Komutları

- `/start` - Bot'u başlat ve bağlantı talimatlarını göster
- `/my_xp` - XP ve seviye bilgilerini göster
- `/leaderboard` - En yüksek XP'li kullanıcıları göster
- `/help` - Tüm komutları göster

## XP Sistemi

- **Mesaj gönderme**: +1 XP
- **Reaksiyon alma**: +2 XP
- **Reaksiyon verme**: +1 XP
- **Günlük aktivite**: +5 XP
- **Haftalık streak**: +10 XP

## Seviyeler

- **Bronze**: 0-100 XP (1 BBLP/gün)
- **Silver**: 101-250 XP (3 BBLP/gün)
- **Gold**: 251-500 XP (5 BBLP/gün)
- **Platinum**: 501-1000 XP (10 BBLP/gün)
- **Diamond**: 1001+ XP (20 BBLP/gün)

## Telegram Login Widget

Widget'ın çalışması için:

1. Bot'unuzun domain'i @BotFather'da ayarlanmış olmalı
2. Widget'da kullanılan bot username doğru olmalı (`denemebot45bot`)
3. Auth URL doğru olmalı (`http://localhost:3000/telegram`)

## Sorun Giderme

### Widget Yüklenmiyor
1. Bot token'ının doğru olduğunu kontrol edin
2. Domain ayarlarını @BotFather'da kontrol edin
3. Bot username'inin doğru olduğunu kontrol edin
4. Browser console'da hata mesajlarını kontrol edin

### Bot Mesaj Göndermiyor
1. Bot'un gruba eklendiğini kontrol edin
2. Bot'un admin olduğunu kontrol edin
3. Group ID'nin doğru olduğunu kontrol edin 