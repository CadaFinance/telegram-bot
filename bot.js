require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');
const { LRUCache } = require('lru-cache');

// Import optimizations
const {
  messageCache,
  processedMessages,
  metrics,
  dbCircuitBreaker,
  batchProcessor,
  rateLimiter,
  OPTIMIZED_POLLING_CONFIG,
  processMessageOptimized,
  cleanup,
  initializeOptimizations,
  setSupabaseClient
} = require('./optimizations');

// Environment variables - Production values
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '7623563807:AAF-x22UGR5xeAVOqLsXbiMEnMtQYuviy-4';
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://vdsoduzvmnuyhwbbnkwi.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZkc29kdXp2bW51eWh3YmJua3dpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTA2MTczNDUsImV4cCI6MjA2NjE5MzM0NX0.stWTGS03eY8IdftKpeylOHURDAkmf6LiKas4_Jdd5cw';
const GROUP_ID = process.env.TELEGRAM_GROUP_ID || '-1002823529287';
const ADMIN_GROUP_ID = process.env.TELEGRAM_ADMIN_GROUP_ID || '-1002879152667'; // Admin/Technical logs group
const WEB_APP_URL = process.env.WEB_APP_URL || 'https://bblip.io';

// Rate limiting configuration (optimized)
const RATE_LIMIT_DELAY = 50; // 50ms between messages (faster)
const RATE_LIMIT_RETRY_DELAY = 2000; // 2 seconds when rate limited

// Anti-bot protection configuration (Rose bot style)
const ANTI_BOT_CONFIG = {
  MIN_MESSAGE_INTERVAL: 1000, // 1 second minimum between messages
  MAX_MESSAGES_PER_MINUTE: 10, // Max 10 messages per minute per user
  MAX_MESSAGES_PER_HOUR: 100, // Max 100 messages per hour per user
  SPAM_DETECTION_WINDOW: 60000, // 1 minute window for spam detection
  SUSPICIOUS_PATTERNS: [
    /(.)\1{4,}/, // Same character repeated 5+ times
    /(.)\1{3,}(.)\2{3,}/, // Two different characters repeated 4+ times each
    /(.)\1{2,}(.)\2{2,}(.)\3{2,}/, // Three different characters repeated 3+ times each
    /^[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]{5,}$/, // Only special characters
    /^[0-9]{10,}$/, // Only numbers (10+ digits)
    /^[a-zA-Z]{20,}$/, // Only letters (20+ characters)
    /(.)\1{2,}(.)\2{2,}(.)\3{2,}(.)\4{2,}/, // Four different characters repeated 3+ times each
  ],
  WARNING_THRESHOLD: 2, // 2 warnings before restriction
  RESTRICT_DURATION: 300, // 5 minutes restriction duration
  BAN_DURATION: 3600, // 1 hour ban duration for severe violations
  XP_PENALTY: 5, // 5 XP penalty for spam
  USE_TELEGRAM_RESTRICTIONS: true, // Use Telegram's native restrictions
  AUTO_UNRESTRICT: true // Automatically unrestrict after duration
};

// Optimized polling configuration
const POLLING_INTERVAL = OPTIMIZED_POLLING_CONFIG.interval; // 500ms (was 100ms)
const POLLING_LIMIT = OPTIMIZED_POLLING_CONFIG.limit; // 50 updates (was 100)
const BATCH_INTERVAL = 30 * 1000; // 30 seconds (was 60 seconds)

// Rate limiting queue (optimized)
const messageQueue = [];
let isProcessingQueue = false;

// Performance monitoring (optimized)
let messageCount = 0;
let lastMessageTime = Date.now();
const PERFORMANCE_LOG_INTERVAL = 100; // Log every 100 messages

// Anti-bot tracking (optimized with LRU cache)
const userMessageHistory = new LRUCache({
  max: 1000,
  maxAge: 1000 * 60 * 30, // 30 minutes
  updateAgeOnGet: true
});

const spamDetections = new LRUCache({
  max: 500,
  maxAge: 1000 * 60 * 60, // 1 hour
  updateAgeOnGet: true
});

// Global anti-spam data (optimized)
global.userSpamData = global.userSpamData || new LRUCache({
  max: 1000,
  maxAge: 1000 * 60 * 30, // 30 minutes
  updateAgeOnGet: true
});

// Global variables for compatibility
let batchProcessingInterval = null;
let xpUpdateQueue = new Map();

console.log('🌐 [BOT] Environment Configuration:');
console.log('  - BOT_TOKEN:', BOT_TOKEN ? '✅ Set' : '❌ Missing');
console.log('  - SUPABASE_URL:', SUPABASE_URL);
console.log('  - GROUP_ID:', GROUP_ID);
console.log('  - WEB_APP_URL:', WEB_APP_URL);
console.log('  - NODE_ENV:', process.env.NODE_ENV || 'development');

// Initialize bot with optimized polling settings
const bot = new TelegramBot(BOT_TOKEN, { 
  polling: {
    interval: POLLING_INTERVAL,
    limit: POLLING_LIMIT,
    retryTimeout: 1000,
    params: {
      timeout: 5 // 5 second timeout using new params format
    },
    autoStart: false // We'll start manually
  }
});

// Initialize Supabase with connection pooling
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  db: {
    schema: 'public',
    pool: {
      min: 2,
      max: 10,
      idleTimeoutMillis: 30000
    }
  },
  auth: {
    persistSession: false // Bot doesn't need session persistence
  },
  global: {
    headers: {
      'X-Client-Info': 'telegram-bot-optimized'
    }
  }
});

// Initialize optimizations
initializeOptimizations();

// Set supabase client for optimizations
setSupabaseClient(supabase);
console.log('🤖 [BOT] Bot initialized successfully');
console.log('📊 [BOT] Supabase client initialized with connection pooling');
console.log('🚀 [BOT] Optimizations initialized');
console.log('🔍 [BOT] Ready to listen for messages...');

// XP calculation constants
const XP_REWARDS = {
  MESSAGE: 1,
  DAILY_ACTIVE: 5,
  WEEKLY_STREAK: 10
};

// Level thresholds
const LEVELS = [
  { name: 'Bronze', minXP: 0, maxXP: 250, reward: 1 },
  { name: 'Silver', minXP: 251, maxXP: 500, reward: 2 },
  { name: 'Gold', minXP: 501, maxXP: 1000, reward: 3 },
  { name: 'Platinum', minXP: 1001, maxXP: 2000, reward: 4 },
  { name: 'Diamond', minXP: 2001, maxXP: 999999, reward: 5 }
];

// Welcome message auto-delete configuration
const WELCOME_MESSAGE_DELETE_DELAY = 30 * 1000; // 30 seconds (30,000ms)
const WELCOME_MESSAGE_DELETE_ENABLED = true; // Enable/disable auto-delete

// Referral system configuration
const REFERRAL_XP_REWARD = 25; // XP for successful referral (daha önce 50 idi)
const REFERRAL_BBLP_REWARD = 5; // BBLP tokens for successful referral
const REFERRAL_SYSTEM_ENABLED = true; // Enable/disable referral system

// Global referral tracking
const pendingReferrals = new Map(); // userId -> referralCode
const referralLinkUsage = new Map(); // referralCode -> usageCount

// Referral system functions
async function generateReferralLink(userId) {
  try {
    console.log(`🔗 Getting referral link for user ${userId}`);
    // First check if user already has an active referral link
    const { data: existingLink, error: checkError } = await supabase
      .from('telegram_referral_links')
      .select('invite_link, referral_code')
      .eq('telegram_id', userId)
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();
    if (existingLink && !checkError) {
      // Legacy referral code düzeltme bloğu kaldırıldı, doğrudan invite_link döndürülüyor
      console.log(`✅ Found existing referral link for user ${userId}: ${existingLink.invite_link}`);
      return existingLink.invite_link;
    }
    // Create new referral link if none exists
    console.log(`🔗 Creating new referral link for user ${userId}`);
    // Create unique referral code (always with underscore)
    const referralCode = `REF${userId}_${Date.now()}`;
    // Create bot referral link (kullanıcıyı önce bota yönlendir)
    const botUsername = 'denemebot45bot'; // Bot'un username'i
    const botReferralLink = `https://t.me/${botUsername}?start=${referralCode}`;
    // Store the referral link in database for tracking
    const { data: referralLink, error } = await supabase
      .from('telegram_referral_links')
      .insert([{
        telegram_id: userId,
        invite_link: botReferralLink,
        referral_code: referralCode,
        is_active: true,
        usage_count: 0,
        max_usage: 100, // Allow up to 100 referrals per user
        expires_at: new Date(Date.now() + (30 * 24 * 60 * 60 * 1000)).toISOString() // 30 days
      }])
      .select()
      .single();
    if (error) {
      console.error(`❌ Error storing referral link:`, error);
      return null;
    }
    console.log(`✅ New bot referral link generated for user ${userId}: ${botReferralLink}`);
    return botReferralLink;
  } catch (error) {
    console.error(`❌ Error generating referral link for user ${userId}:`, error);
    return null;
  }
}

async function processReferral(referrerId, referredId, referralCode = null) {
  try {
    console.log(`🎯 Processing referral: ${referrerId} -> ${referredId} with code: ${referralCode}`);
    // Fallback: If referralCode is missing underscore, try to fix it
    let codeToUse = referralCode;
    if (referralCode && !referralCode.includes('_')) {
      codeToUse = referralCode.replace(/^REF(\d+)/, (m, p1) => `REF${p1}_${Date.now()}`);
      console.warn(`⚠️ Legacy referral code without underscore detected in processReferral. Fixed: ${codeToUse}`);
    }
    // Check if user already joined via referral
    const { data: existingTracking, error: checkError } = await supabase
      .from('telegram_referral_tracking')
      .select('*')
      .eq('telegram_id', referredId)
      .single();
    if (existingTracking) {
      console.log(`⚠️ User ${referredId} already joined via referral: ${existingTracking.referrer_id}`);
      return false;
    }
    // Check if referred user is already registered in telegram_users
    const { data: existingUser, error: userCheckError } = await supabase
      .from('telegram_users')
      .select('*')
      .eq('telegram_id', referredId)
      .single();
    if (existingUser) {
      console.log(`⚠️ User ${referredId} is already registered, ignoring referral`);
      return false; // Don't process referral for existing users
    }
    // User is new (not registered), give XP reward
    console.log(`🎉 User ${referredId} is new, giving XP reward to referrer ${referrerId}`);
    // Create referral tracking record
    const { data: tracking, error: insertError } = await supabase
      .from('telegram_referral_tracking')
      .insert([{
        telegram_id: referredId,
        referrer_id: referrerId,
        referral_code: codeToUse || `REF${referrerId}_${Date.now()}`,
        xp_rewarded: REFERRAL_XP_REWARD
      }])
      .select()
      .single();
    if (insertError) {
      console.error(`❌ Error creating referral tracking record:`, insertError);
      return false;
    }
    console.log(`✅ Referral tracking record created: ${tracking.id}`);
    // Award XP to referrer (only for new users)
    await awardReferralXP(referrerId, REFERRAL_XP_REWARD);
    // Award BBLP to referrer (if connected to wallet)
    await awardReferralBBLP(referrerId, REFERRAL_BBLP_REWARD);
    // Update referrer's referral count
    await updateReferralCount(referrerId);
    return true;
  } catch (error) {
    console.error(`❌ Error processing referral:`, error);
    return false;
  }
}

async function awardReferralXP(telegramId, xpAmount) {
  try {
    console.log(`🎁 Awarding ${xpAmount} XP to referrer ${telegramId}`);
    
    // Get current activity
    const { data: activity, error } = await supabase
      .from('telegram_activities')
      .select('total_xp')
      .eq('telegram_id', telegramId)
      .single();
    
    if (error) {
      console.error(`❌ Error fetching activity for referral XP:`, error);
      return;
    }
    
    const newTotalXP = (activity?.total_xp || 0) + xpAmount;
    
    // Update XP
    await supabase
      .from('telegram_activities')
      .update({ total_xp: newTotalXP })
      .eq('telegram_id', telegramId);
    
    console.log(`✅ Referral XP awarded: ${telegramId} now has ${newTotalXP} XP`);
    
    // Send congratulation message to referrer
    try {
      // Get or create referral link for this user
      // const referralLink = await generateReferralLink(telegramId); // no longer needed for button
      const congratulationMessage = `🎉 *Congratulations\!* 🎉\n\n👥 *You successfully referred a new user\!*\n\n🎁 *Rewards Earned:*\n• XP: \\+${xpAmount}\n• BBLP: \\+${REFERRAL_BBLP_REWARD}\n\n📊 *Your New Stats:*\n• Total XP: ${newTotalXP.toLocaleString()}\n• Level: ${calculateLevel(newTotalXP)} \\(${getLevelName(calculateLevel(newTotalXP))}\\)\n\n💎 *Keep sharing your referral link to earn more rewards\!*\n\n🚀 *Next Goal:*\nShare your link with more friends and earn even more XP\!`;
        await bot.sendMessage(telegramId, congratulationMessage, { 
          parse_mode: 'Markdown'
        });
        console.log(`✅ Congratulation message sent to referrer ${telegramId}`);
      } catch (error) {
        console.error(`❌ Error sending congratulation message:`, error);
      }
    
  } catch (error) {
    console.error(`❌ Error awarding referral XP:`, error);
  }
}

async function awardReferralBBLP(telegramId, bblpAmount) {
  try {
    console.log(`🎁 Awarding ${bblpAmount} BBLP to referrer ${telegramId}`);
    
    // Get user's wallet connection
    const { data: telegramUser, error } = await supabase
      .from('telegram_users')
      .select('user_id')
      .eq('telegram_id', telegramId)
      .single();
    
    if (error || !telegramUser) {
      console.log(`⚠️ User ${telegramId} not connected to wallet, BBLP reward pending`);
      return;
    }
    
    // Create BBLP reward record
    await supabase
      .from('telegram_rewards')
      .insert([{
        user_id: telegramUser.user_id,
        reward_type: 'referral',
        bblp_amount: bblpAmount.toString(),
        xp_earned: 0,
        claimed: false
      }]);
    
    console.log(`✅ Referral BBLP reward recorded for user ${telegramId}`);
    
  } catch (error) {
    console.error(`❌ Error awarding referral BBLP:`, error);
  }
}

async function updateReferralCount(telegramId) {
  try {
    // Get current referral count from tracking table
    const { count: currentCount, error: countError } = await supabase
      .from('telegram_referral_tracking')
      .select('*', { count: 'exact', head: true })
      .eq('referrer_id', telegramId);
    
    if (countError) {
      console.error(`❌ Error counting referrals:`, countError);
      return;
    }
    
    // Update referral count in telegram_activities
    await supabase
      .from('telegram_activities')
      .update({ referral_count: currentCount })
      .eq('telegram_id', telegramId);
    
    console.log(`✅ Referral count updated for ${telegramId}: ${currentCount}`);
    
  } catch (error) {
    console.error(`❌ Error updating referral count:`, error);
  }
}

// Basit referral tracking - sadece duplicate kontrolü
async function checkReferralDuplicate(telegramId) {
  try {
    const { data: existing, error } = await supabase
      .from('telegram_referral_tracking')
      .select('telegram_id')
      .eq('telegram_id', telegramId)
      .single();
    
    if (error && error.code !== 'PGRST116') {
      console.error(`❌ Error checking referral duplicate:`, error);
      return false; // Allow if error
    }
    
    return !!existing; // true if exists, false if not
  } catch (error) {
    console.error(`❌ Error checking referral duplicate:`, error);
    return false; // Allow if error
  }
}

async function sendAccountConnectedMessage(telegramId, username) {
  try {
    console.log(`🎉 Sending account connected message to user ${telegramId}`);
    
    // Get or create referral link for newly connected user
    const referralLink = await generateReferralLink(telegramId);
    
    const message = `🎉 *Account Successfully Connected\!* 🎉

👋 *Hello @${username}\!* Welcome to BBLIP Community\!

✅ *Status: Connected*
🔗 *Wallet: Connected*
💼 *Referral System: Active*

🎯 *What You Can Do Now:*
• Send messages to earn XP
• Level up for better rewards
• Claim daily BBLP tokens
• Share your referral link
• Climb the leaderboard

⚡ *Quick Commands:*
/my\_xp - Check your progress
/leaderboard - See top players
/help - Show all commands

🚀 *Start earning XP by chatting\!*
Your messages will earn you XP automatically\!

🔗 *Connect wallet to get your referral link and earn BBLP rewards\!*`;

    const keyboard = {
      inline_keyboard: [
        [{
          text: '🔗 Share My Referral Link',
          url: referralLink
        }],
        [{
          text: '💼 Connect Wallet',
          url: `${WEB_APP_URL}/telegram`
        }],
        [{
          text: '📊 My XP Stats',
          callback_data: 'my_xp'
        }]
      ]
    };

    await bot.sendMessage(telegramId, message, {
      parse_mode: 'Markdown',
      reply_markup: keyboard
    });
    
    console.log(`✅ Account connected message sent to user ${telegramId}`);
  } catch (error) {
    console.error(`❌ Error sending account connected message:`, error);
  }
}



// Welcome message handler function
async function handleNewMember(chatId, newMember) {
  const userId = newMember.id;
  const username = newMember.username || newMember.first_name;
  const isBot = newMember.is_bot;
  
  console.log(`👋 Processing new member:`);
  console.log(`  - Chat ID: ${chatId}`);
  console.log(`  - User ID: ${userId}`);
  console.log(`  - Username: @${username}`);
  console.log(`  - Is Bot: ${isBot}`);
  
  // Skip bots
  if (isBot) {
    console.log(`🤖 Skipping bot: @${username}`);
    return;
  }
  
  try {
    // Check if user is in our database
    const { data: telegramUser, error } = await supabase
      .from('telegram_users')
      .select('*')
      .eq('telegram_id', userId)
      .single();
    
    console.log(`📊 Database query result for new member:`);
    console.log(`  - User found: ${!!telegramUser}`);
    console.log(`  - Error: ${error ? JSON.stringify(error) : 'None'}`);
    
    // Check for pending referral code (from /start command)
    const pendingReferralCode = pendingReferrals.get(userId);
    let referralProcessed = false;
    
    if (REFERRAL_SYSTEM_ENABLED && pendingReferralCode) {
      try {
        console.log(`🎯 Processing pending referral for new user ${userId} with code: ${pendingReferralCode}`);
        
        // Extract referrer ID from referral code (format: REF123456_1234567890)
        const referrerIdMatch = pendingReferralCode.match(/^REF(\d+)_/);
        if (referrerIdMatch) {
          const referrerId = parseInt(referrerIdMatch[1]);
          
          // Don't allow self-referral
          if (referrerId !== userId) {
            console.log(`🎯 Processing referral: ${referrerId} -> ${userId}`);
            const referralSuccess = await processReferral(referrerId, userId);
            
            if (referralSuccess) {
              console.log(`✅ Referral processed successfully for new user ${userId}`);
              referralProcessed = true;
            } else {
              console.log(`⚠️ Referral processing failed for new user ${userId}`);
            }
          } else {
            console.log(`⚠️ Self-referral attempted by new user ${userId}`);
          }
        } else {
          console.log(`⚠️ Invalid referral code format: ${pendingReferralCode}`);
        }
        
        // Remove the referral code from pending list
        pendingReferrals.delete(userId);
      } catch (error) {
        console.error(`❌ Error processing referral for new user:`, error);
      }
    }
    
    if (error || !telegramUser) {
      // New user - send welcome message
      const message = `🎉 Welcome to BBLIP!

Hi @${username}, glad to have you in our global crypto community!

What's next?
- 🚀 Start earning rewards by chatting and engaging.
- 💳 Connect your wallet to unlock daily BBLP token rewards.
- 🏆 Climb the leaderboard and win exclusive prizes.

Quick Start:
1. Connect your wallet below
2. Start chatting to earn XP & BBLP
3. Use /help for all commands

Your journey to smarter crypto rewards starts now!`;
      
      const keyboard = {
        inline_keyboard: [[
          {
            text: '🔗 Connect Wallet',
            url: `${WEB_APP_URL}/social-connections`
          }
        ]]
      };
      
      console.log(`📤 Sending welcome message to new member...`);
      const sentMessage = await sendMessageWithRateLimit(chatId, message, {
        reply_markup: keyboard
      });
      console.log(`✅ Welcome message sent to new member`);
      
      // Auto-delete welcome message after delay
      if (WELCOME_MESSAGE_DELETE_ENABLED && sentMessage && sentMessage.message_id) {
        setTimeout(async () => {
          try {
            await bot.deleteMessage(chatId, sentMessage.message_id);
            console.log(`🗑️ Welcome message auto-deleted for new member @${username} (after ${WELCOME_MESSAGE_DELETE_DELAY/1000}s)`);
          } catch (error) {
            console.log(`⚠️ Could not auto-delete welcome message: ${error.message}`);
          }
        }, WELCOME_MESSAGE_DELETE_DELAY);
      }
      
      // Send admin log (no auto-delete for admin logs)
      await sendAdminLog(`👋 New member joined: @${username} (ID: ${userId}) - Not connected to wallet yet${referralProcessed ? ' - Referral processed' : ''}`);
      
      // Send private connection message to user
      try {
        const privateMessage = `🔗 **Account Connection Required** 🔗

👋 **Hello @${username}!** Welcome to BBLIP Community!

📊 **Current Status:** ❌ Not Connected
💬 **Chat Activity:** ❌ No XP Rewards
🎁 **Daily Rewards:** ❌ Not Available

⚠️ **Important:** You need to connect your wallet to start earning XP from chat activity!

🎯 **Quick Connection Steps:**
1️⃣ Visit: ${WEB_APP_URL}/telegram
2️⃣ Connect your wallet (MetaMask, etc.)
3️⃣ Click "Connect Telegram" button
4️⃣ Use Telegram Login Widget

💎 **What You'll Get After Connection:**
• Real-time XP from messages
• Daily BBLP token rewards
• Level up notifications
• Community leaderboards
• Anti-bot protection

⚡ **Commands Available After Connection:**
/my_xp - Check your progress
/leaderboard - See top players
/help - Show all commands

🚀 **Ready to start earning?**
Click the button below to connect your account!`;

        // Send private message with inline keyboard
        const keyboard = {
          inline_keyboard: [[
            {
              text: '🔗 Connect My Account',
              url: `${WEB_APP_URL}/telegram`
            }
          ]]
        };

        await bot.sendMessage(userId, privateMessage, {
          parse_mode: 'Markdown',
          reply_markup: keyboard
        });
        
        console.log(`📱 Private connection message sent to @${username} (${userId})`);
        
        // Auto-delete private message after 5 minutes
        setTimeout(async () => {
          try {
            // Note: We can't delete private messages sent to users
            // But we can log that the message was sent
            console.log(`⏰ Private connection message timeout for @${username} (${userId})`);
          } catch (error) {
            console.log(`⚠️ Could not handle private message timeout: ${error.message}`);
          }
        }, 5 * 60 * 1000); // 5 minutes
        
      } catch (error) {
        console.error(`❌ Error sending private connection message to @${username}:`, error);
        // If private message fails, send a public reminder
        const publicReminder = `👋 @${username} Welcome! Please check your private messages from me to connect your account and start earning XP!`;
        await sendMessageWithRateLimit(chatId, publicReminder);
      }
      
    } else {
      // Returning user - send welcome back message
      const message = `🎉 **Welcome Back to BBLIP!** 🎉

👋 **Hello @${username}!** Great to see you again!

✅ **Status: Connected**
💼 Wallet: ${String(telegramUser.user_id).slice(0, 6)}...${String(telegramUser.user_id).slice(-4)}

🎯 **Your Journey Continues:**
• Send messages to earn XP
• Level up for better rewards
• Claim daily BBLP tokens
• Climb the leaderboard

⚡ **Quick Commands:**
/my\\_xp - Check your progress
/leaderboard - See top players
/help - Show all commands

🚀 **Keep chatting and earning!**
Your messages will earn you XP automatically!`;
      
      console.log(`📤 Sending welcome back message to returning member...`);
      const sentMessage = await sendMessageWithRateLimit(chatId, message);
      console.log(`✅ Welcome back message sent to returning member`);
      
      // Auto-delete welcome back message after delay
      if (WELCOME_MESSAGE_DELETE_ENABLED && sentMessage && sentMessage.message_id) {
        setTimeout(async () => {
          try {
            await bot.deleteMessage(chatId, sentMessage.message_id);
            console.log(`🗑️ Welcome back message auto-deleted for returning member @${username} (after ${WELCOME_MESSAGE_DELETE_DELAY/1000}s)`);
          } catch (error) {
            console.log(`⚠️ Could not auto-delete welcome back message: ${error.message}`);
          }
        }, WELCOME_MESSAGE_DELETE_DELAY);
      }
      
      // Send admin log (no auto-delete for admin logs)
      await sendAdminLog(`👋 Returning member joined: @${username} (ID: ${userId}) - Connected to wallet: ${String(telegramUser.user_id).slice(0, 6)}...${String(telegramUser.user_id).slice(-4)}`);
    }
    
  } catch (error) {
    console.error('❌ Error handling new member:', error);
    await sendAdminError(error, `New member join - User: @${username} (${userId})`);
  }
}

// Bot commands
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  // Prevent /start in group chats
  if (msg.chat.type === 'group' || msg.chat.type === 'supergroup') {
    return;
  }
  const userId = msg.from.id;
  const username = msg.from.username || msg.from.first_name;
  const args = msg.text.split(' ');
  
  // Check for referral code in start command
  let referralCode = null;
  if (args.length > 1) {
    referralCode = args[1];
    console.log(`🔗 Referral code detected in /start: ${referralCode}`);
    
    // Store referral code for this user
    pendingReferrals.set(userId, referralCode);
    console.log(`📝 Stored referral code ${referralCode} for user ${userId}`);
    
    // Track referral link usage
    const currentUsage = referralLinkUsage.get(referralCode) || 0;
    referralLinkUsage.set(referralCode, currentUsage + 1);
    console.log(`📊 Referral link usage for ${referralCode}: ${currentUsage + 1}`);
  }
  
  console.log(`🚀 /start command received:`);
  console.log(`  - Chat ID: ${chatId}`);
  console.log(`  - User ID: ${userId}`);
  console.log(`  - Username: @${username}`);
  console.log(`  - Args: ${JSON.stringify(args)}`);
  console.log(`  - Referral code: ${referralCode || 'None'}`);
  
  try {
    console.log(`🔍 Checking if user ${userId} exists in database...`);
    
    // Check if user is in our database
    const { data: telegramUser, error } = await supabase
      .from('telegram_users')
      .select('*')
      .eq('telegram_id', userId)
      .single();
    
    console.log(`📊 Database query result:`);
    console.log(`  - User found: ${!!telegramUser}`);
    console.log(`  - Error: ${error ? JSON.stringify(error) : 'None'}`);
    console.log(`  - User data: ${telegramUser ? JSON.stringify(telegramUser) : 'Not found'}`);
    
    if (error || !telegramUser) {
      console.log(`❌ User not connected, sending connection instructions...`);
      
      // Process referral even if user is not connected yet
      if (REFERRAL_SYSTEM_ENABLED && referralCode) {
        try {
          console.log(`🎯 Processing referral for unconnected user ${userId} with code: ${referralCode}`);
          
          // Check if user already used referral
          const isDuplicate = await checkReferralDuplicate(userId);
          if (isDuplicate) {
            console.log(`⚠️ User ${userId} already used referral before`);
            return;
          }
          
          // Extract referrer ID from referral code (format: REF123456_1234567890)
          const referrerIdMatch = referralCode.match(/^REF(\d+)_/);
          if (referrerIdMatch) {
            const referrerId = parseInt(referrerIdMatch[1]);
            
            // Don't allow self-referral
            if (referrerId !== userId) {
              console.log(`🎯 Processing referral: ${referrerId} -> ${userId}`);
              const referralSuccess = await processReferral(referrerId, userId, referralCode);
              
              if (referralSuccess) {
                console.log(`✅ Referral processed successfully for unconnected user ${userId}`);
                
                // Only show success message for new users
                const successMessage = `🎉 *Referral Success\!* 🎉

👋 *Hello @${username}\\!* Welcome to BBLIP Community\!

✅ *Referral Processed:*
• You joined using a referral link
• The referrer has been rewarded with XP
• Your referral is now tracked

🚀 *Next Steps:*
1️⃣ Join our main community group
2️⃣ Connect your wallet to start earning XP
3️⃣ Start chatting to earn rewards

💎 *What You'll Get:*
• Real\-time XP from messages
• Daily BBLP token rewards
• Level up notifications
• Community leaderboards

🔗 *Join Our Community:*`;

                const keyboard = {
                  inline_keyboard: [
                    [{
                      text: '🚀 Join BBLIP Community',
                      url: `https://t.me/+XqnFyuXylP01MjI0`
                    }],
                    [{
                      text: '🔗 Connect Wallet',
                      url: `${WEB_APP_URL}/telegram`
                    }]
                  ]
                };

                await bot.sendMessage(userId, successMessage, {
                  parse_mode: 'Markdown',
                  reply_markup: keyboard
                });
                
                console.log(`✅ Referral success message sent to unconnected user ${userId}`);
                return; // Don't send the regular connection message
                
              } else {
                console.log(`⚠️ Referral processing failed for unconnected user ${userId}`);
              }
            } else {
              console.log(`⚠️ Self-referral attempted by unconnected user ${userId}`);
            }
          } else {
            console.log(`⚠️ Invalid referral code format: ${referralCode}`);
          }
        } catch (error) {
          console.error(`❌ Error processing referral for unconnected user:`, error);
        }
      }
      
      if (args[1] === 'connect') {
        const message = `🔗 **Manual Connection Mode** 🔗

👋 **Hello @${username}!** Let's get you connected to start earning!

📋 **Your Details:**
🆔 Telegram ID: ${userId}
👤 Username: @${username}

🎯 **Connection Steps:**
1️⃣ Visit: ${WEB_APP_URL}/telegram
2️⃣ Connect your wallet
3️⃣ Click "Connect Telegram" button
4️⃣ Use the Telegram Login Widget

💎 **What You'll Get:**
• Real-time XP tracking
• Daily BBLP rewards
• Level up notifications
• Community leaderboards

⚡ **Once Connected:**
/my_xp - View your XP and level
/leaderboard - View top users
/help - Show all commands

🚀 **Ready to start earning?**
Follow the steps above and join the BBLIP community!`;
        
        console.log(`📤 Sending manual connection message...`);
        await sendMessageWithRateLimit(chatId, message);
        console.log(`✅ Manual connection message sent`);
      } else {
        const message = `🎉 **Welcome to BBLIP Community!** 🎉

👋 **Hello @${username}!** We're excited to have you join our amazing crypto community!

🌟 **What's BBLIP?**
BBLIP transforms your crypto into spendable currency with virtual and physical cards accepted at 40M+ merchants worldwide!

🎯 **Quick Start Guide:**
1️⃣ Visit: ${WEB_APP_URL}/telegram
2️⃣ Connect your wallet
3️⃣ Click "Connect Telegram" button
4️⃣ Start earning XP instantly!

💎 **Reward System:**
🥉 Bronze (0-100 XP): 1 BBLP/day
🥈 Silver (101-250 XP): 3 BBLP/day
🥇 Gold (251-500 XP): 5 BBLP/day
💎 Platinum (501-1000 XP): 10 BBLP/day
👑 Diamond (1001+ XP): 20 BBLP/day

⚡ **Features:**
• Real-time XP tracking
• Instant level up notifications
• Daily BBLP rewards
• Community leaderboards
• Anti-bot protection

🎮 **Commands:**
/start - Begin your journey
/my_xp - Check your stats
/leaderboard - See top players
/help - Show all commands

🚀 **Ready to earn while you chat?**
Your messages will earn you XP automatically!${referralProcessed ? '\n\n🎉 **Referral Bonus Applied!** 🎉\nYou joined using a referral link and the referrer has been rewarded!' : ''}`;
        
        console.log(`📤 Sending welcome message...`);
        const sentMessage = await sendMessageWithRateLimit(chatId, message);
        console.log(`✅ Welcome message sent`);
        
        // Auto-delete welcome message after delay
        if (WELCOME_MESSAGE_DELETE_ENABLED && sentMessage && sentMessage.message_id) {
          setTimeout(async () => {
            try {
              await bot.deleteMessage(chatId, sentMessage.message_id);
              console.log(`🗑️ Welcome message auto-deleted for @${username} (after ${WELCOME_MESSAGE_DELETE_DELAY/1000}s)`);
            } catch (error) {
              console.log(`⚠️ Could not auto-delete welcome message: ${error.message}`);
            }
          }, WELCOME_MESSAGE_DELETE_DELAY);
        }
        
        // Send private connection message to user
        try {
          const privateMessage = `🔗 **Account Connection Required** 🔗

👋 **Hello @${username}!** Welcome to BBLIP Community!

📊 **Current Status:** ❌ Not Connected
💬 **Chat Activity:** ❌ No XP Rewards
🎁 **Daily Rewards:** ❌ Not Available

⚠️ **Important:** You need to connect your wallet to start earning XP from chat activity!

🎯 **Quick Connection Steps:**
1️⃣ Visit: ${WEB_APP_URL}/telegram
2️⃣ Connect your wallet (MetaMask, etc.)
3️⃣ Click "Connect Telegram" button
4️⃣ Use Telegram Login Widget

💎 **What You'll Get After Connection:**
• Real-time XP from messages
• Daily BBLP token rewards
• Level up notifications
• Community leaderboards
• Anti-bot protection

⚡ **Commands Available After Connection:**
/my_xp - Check your progress
/leaderboard - See top players
/help - Show all commands

🚀 **Ready to start earning?**
Click the button below to connect your account!`;

          // Send private message with inline keyboard
          const keyboard = {
            inline_keyboard: [[
              {
                text: '🔗 Connect My Account',
                url: `${WEB_APP_URL}/telegram`
              }
            ]]
          };

          await bot.sendMessage(userId, privateMessage, {
            parse_mode: 'Markdown',
            reply_markup: keyboard
          });
          
          console.log(`📱 Private connection message sent to @${username} (${userId}) via /start`);
          
        } catch (error) {
          console.error(`❌ Error sending private connection message to @${username}:`, error);
          // If private message fails, send a public reminder
          const publicReminder = `👋 @${username} Welcome! Please check your private messages from me to connect your account and start earning XP!`;
          await sendMessageWithRateLimit(chatId, publicReminder);
        }
      }
      return;
    }
    
    console.log(`✅ User already connected to wallet: ${telegramUser.user_id}`);
    
    // Process referral if code was provided
    if (REFERRAL_SYSTEM_ENABLED && referralCode) {
      try {
        console.log(`🎯 Processing referral from /start command: ${referralCode}`);
        
        // Check if user already used referral
        const isDuplicate = await checkReferralDuplicate(userId);
        if (isDuplicate) {
          console.log(`⚠️ User ${userId} already used referral before`);
          return;
        }
        
        // Extract referrer ID from referral code (format: REF123456_1234567890)
        const referrerIdMatch = referralCode.match(/^REF(\d+)_/);
        if (referrerIdMatch) {
          const referrerId = parseInt(referrerIdMatch[1]);
          
          // Don't allow self-referral
          if (referrerId !== userId) {
            console.log(`🎯 Processing referral: ${referrerId} -> ${userId}`);
            const referralSuccess = await processReferral(referrerId, userId, referralCode);
            
            if (referralSuccess) {
              console.log(`✅ Referral processed successfully for user ${userId}`);
              
              // Only show success message for new users
              const successMessage = `🎉 *Referral Success\!* 🎉

👋 *Hello @${username}\\!* Welcome to BBLIP Community\!

✅ *Referral Processed:*
• You joined using a referral link
• The referrer has been rewarded with XP
• Your account is now connected

🚀 *Next Steps:*
1️⃣ Join our main community group
2️⃣ Start chatting to earn XP
3️⃣ Connect your wallet for BBLP rewards

💎 *What You'll Get:*
• Real\-time XP from messages
• Daily BBLP token rewards
• Level up notifications
• Community leaderboards

🔗 *Join Our Community:*`;

              const keyboard = {
                inline_keyboard: [
                  [{
                    text: '🚀 Join BBLIP Community',
                    url: `https://t.me/+XqnFyuXylP01MjI0`
                  }],
                  [{
                    text: '🔗 Connect Wallet',
                    url: `${WEB_APP_URL}/telegram`
                  }]
                ]
              };

              await bot.sendMessage(userId, successMessage, {
                parse_mode: 'Markdown',
                reply_markup: keyboard
              });
              
              console.log(`✅ Referral success message sent to user ${userId}`);
              return; // Don't send the regular welcome message
              
            } else {
              console.log(`⚠️ Referral processing failed for user ${userId}`);
            }
          } else {
            console.log(`⚠️ Self-referral attempted by user ${userId}`);
          }
        } else {
          console.log(`⚠️ Invalid referral code format: ${referralCode}`);
        }
      } catch (error) {
        console.error(`❌ Error processing referral from /start:`, error);
      }
    }
    
    // Get or create referral link for connected user
    const referralLink = await generateReferralLink(userId);
    
    // Güçlü MarkdownV2 kaçış fonksiyonu
    function escapeMarkdownV2(text) {
      return String(text)
        .replace(/([_\*\[\]\(\)~`>#+\-=|{}.!\\])/g, '\\$1');
    }

    const safeUserDisplayName = escapeMarkdownV2(userDisplayName);
    const safeReferralLink = escapeMarkdownV2(referralLink);
    const safeXP = escapeMarkdownV2(REFERRAL_XP_REWARD);
    const safeBBLP = escapeMarkdownV2(REFERRAL_BBLP_REWARD);

    // Escape all message lines for MarkdownV2
    const messageLines = [
      '🚀 *Invite & Earn Rewards!*',
      '',
      `Hi ${safeUserDisplayName}! Here\'s your unique invite link:`,
      '',
      '➡️',
      `${safeReferralLink}`,
      '',
      '🎁 *What You Get:*',
      `• +${safeXP} XP for every friend who joins`,
      `• +${safeBBLP} BBLP tokens per referral`,
      '• Track your progress and climb the leaderboard!',
      '',
      '💡 *How it works:*',
      '1️⃣ Share your link with friends (use the Share or Copy button below)',
      '2️⃣ They click the link, start the bot, and join our group',
      '3️⃣ You both get rewarded instantly!',
      '',
      '📈 *Tip:* The more you share, the more you earn!',
      '',
      '*Note: Your friend must start the bot and join the group for your reward to be counted.*'
    ];
    // Escape each line for MarkdownV2
    const safeMessage = messageLines.map(escapeMarkdownV2).join('\n');

    const shareMessage = `🚀 Join me on BBLIP and unlock exclusive crypto rewards!\n\n💰 $100,000 Prize Pool! 💰\n\nBBLIP is the next-gen platform to earn, spend, and grow your crypto with real utility.\n\n👉 Tap the link to get started:\n${referralLink}\n\nWhy join?\n• Earn daily BBLP token rewards\n• Level up for bigger bonuses\n• Compete on the leaderboard\n• Invite friends and multiply your earnings!\n• Win a share of the $100,000 prize pool!\n\nLet's grow together in the BBLIP community!`;

    const keyboard = {
      inline_keyboard: [
        [
          {
            text: '📤 Share Referral Link',
            url: `https://t.me/share/url?url=&text=${encodeURIComponent(shareMessage)}`
          }
        ]
      ]
    };

    // Callback handler'ı globalde bir kez tanımla
    if (!global.__copyReferralHandlerSet) {
      bot.on('callback_query', async (callbackQuery) => {
        if (callbackQuery.data && callbackQuery.data === 'copy_referral_link') {
          const chatId = callbackQuery.message.chat.id;
          // Look up the referral link for this user
          const userId = callbackQuery.from.id;
          // Get or create referral link for this user
          const referralLink = await generateReferralLink(userId);
          await bot.answerCallbackQuery(callbackQuery.id, { text: 'Referans linkin aşağıda!', show_alert: false });
          await bot.sendMessage(
            chatId,
            `📋 Referans linkin:\n${referralLink}\n\nKopyalamak için linke uzun bas ve 'Kopyala'ya tıkla.`,
          );
        }
      });
      global.__copyReferralHandlerSet = true;
    }

    const sentMessage = await sendMessageWithRateLimit(chatId, safeMessage, {
      parse_mode: 'MarkdownV2',
      reply_markup: keyboard
    });
    if (msg.chat.type === 'group' || msg.chat.type === 'supergroup') {
      setTimeout(async () => {
        try {
          await bot.deleteMessage(chatId, sentMessage.message_id);
          console.log(`🗑️ Deleted message ${sentMessage.message_id} after 15s`);
        } catch (e) {
          console.error(`❌ Failed to auto-delete message ${sentMessage.message_id}:`, e);
        }
      }, 15000);
    }
    
  } catch (error) {
    console.error('❌ Error in /start command:', error);
    console.error('Error details:', JSON.stringify(error, null, 2));
    await sendMessageWithRateLimit(chatId, 'Sorry, something went wrong. Please try again.');
  }
});

bot.onText(/\/my_xp/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const userDisplayName = getUserDisplayName(msg);

  try {
    // First, check if user is registered in telegram_users
    const { data: telegramUser, error: userError } = await supabase
      .from('telegram_users')
      .select('*')
      .eq('telegram_id', userId)
      .single();

    if (userError || !telegramUser) {
      // User is not registered, prompt to connect wallet
      const notRegisteredMsg = `🔗 <b>Connect Your Wallet to Start Earning XP</b>\n\n${userDisplayName}, to start earning XP, please connect your wallet first.\nOnce connected, your chat activity will be rewarded automatically.`;
      const keyboard = {
        inline_keyboard: [[
          {
            text: '🔗 Connect Wallet',
            url: `${WEB_APP_URL}/social-connections`
          }
        ]]
      };
      await sendMessageWithRateLimit(chatId, notRegisteredMsg, { parse_mode: 'HTML', reply_markup: keyboard });
      return;
    }

    // Get user's activity data from telegram_activities table
    const { data: activity, error } = await supabase
      .from('telegram_activities')
      .select('*, referral_count')
      .eq('telegram_id', userId)
      .single();

    if (error || !activity) {
      // Send private connection message
      try {
        const privateMessage = `🔗 **Account Connection Required** 🔗

👋 **Hello!** You're not connected to our system yet.

📊 **Current Status:** ❌ Not Connected
💬 **Chat Activity:** ❌ No XP Rewards
🎁 **Daily Rewards:** ❌ Not Available

⚠️ **To check your XP and earn rewards:**
1️⃣ Visit: ${WEB_APP_URL}/telegram
2️⃣ Connect your wallet (MetaMask, etc.)
3️⃣ Click "Connect Telegram" button
4️⃣ Use Telegram Login Widget

💎 **After connection you'll get:**
• Real-time XP tracking
• Daily BBLP token rewards
• Level up notifications
• Community leaderboards

⚡ **Commands Available After Connection:**
/my_xp - Check your progress
/leaderboard - See top players
/help - Show all commands

🚀 **Connect now to start earning!**`;

        const keyboard = {
          inline_keyboard: [[
            {
              text: '🔗 Connect My Account',
              url: `${WEB_APP_URL}/telegram`
            }
          ]]
        };

        await bot.sendMessage(userId, privateMessage, {
          parse_mode: 'Markdown',
          reply_markup: keyboard
        });
        await sendMessageWithRateLimit(chatId, '👋 Please check your private messages from me to connect your account and start earning XP!');
      } catch (error) {
        await sendMessageWithRateLimit(chatId, 'You are not connected to our system. Please visit our web app first.');
      }
      return;
    }

    // Add cached data to get real-time stats
    let totalXP = activity.total_xp;
    let messageCount = activity.message_count;
    
    if (messageCache.has(userId)) {
      const cached = messageCache.get(userId);
      totalXP += cached.xpEarned;
      messageCount += cached.messageCount;
      
      console.log(`📊 Real-time stats for user ${userDisplayName}:`, {
        database: { xp: activity.total_xp, messages: activity.message_count },
        cached: { xp: cached.xpEarned, messages: cached.messageCount },
        total: { xp: totalXP, messages: messageCount }
      });
    }
    
    const currentLevel = calculateLevel(totalXP);
    const nextLevel = currentLevel + 1;
    
    // Calculate XP needed for next level based on level thresholds
    let xpToNext = 0;
    if (currentLevel === 1) xpToNext = 101 - totalXP; // Bronze to Silver
    else if (currentLevel === 2) xpToNext = 251 - totalXP; // Silver to Gold
    else if (currentLevel === 3) xpToNext = 501 - totalXP; // Gold to Platinum
    else if (currentLevel === 4) xpToNext = 1001 - totalXP; // Platinum to Diamond
    else xpToNext = 0; // Diamond level
    
    const currentLevelName = getLevelName(currentLevel);
    const nextLevelName = getLevelName(nextLevel);
    
    const referralCount = activity.referral_count || 0;
    
    let message = `📊 Your XP Stats\n\n` +
      `👤 User: ${userDisplayName}\n` +
      `🏆 Level: ${currentLevel} (${currentLevelName})\n` +
      `⭐ Total XP: ${totalXP.toLocaleString()}\n` +
      `💬 Messages: ${messageCount.toLocaleString()}\n` +
      `🔗 Referrals: ${referralCount}\n\n`;
    
    if (xpToNext > 0) {
      message += `📈 ${xpToNext.toLocaleString()} XP needed for Level ${nextLevel} (${nextLevelName})`;
    } else {
      message += `🎉 You've reached the highest level (${currentLevelName})!`;
    }
    
    // Add cache info if there's pending data
    if (messageCache.has(userId)) {
      const cached = messageCache.get(userId);
      message += `\n\n⏰ Pending: +${cached.xpEarned} XP (${cached.messageCount} messages) - Will be saved in next batch`;
    }
    
    await sendMessageWithRateLimit(chatId, message).then(sentMessage => {
      // Auto-delete after 15 seconds if in a group
      if (msg.chat.type === 'group' || msg.chat.type === 'supergroup') {
        setTimeout(async () => {
          try {
            await bot.deleteMessage(chatId, sentMessage.message_id);
            console.log(`🗑️ Deleted message ${sentMessage.message_id} after 15s`);
          } catch (e) {
            console.error(`❌ Failed to auto-delete message ${sentMessage.message_id}:`, e);
          }
        }, 15000);
      }
    });
    console.log(`✅ XP stats sent to ${userDisplayName}`);
    
  } catch (error) {
    console.error('❌ Error in /my_xp command:', error);
    await sendMessageWithRateLimit(chatId, '❌ Error fetching your XP stats. Please try again.');
  }
});

bot.onText(/\/leaderboard/, async (msg) => {
  const chatId = msg.chat.id;
  
  try {
    console.log('📊 Fetching leaderboard data...');
    
    // Get top 10 users by XP from telegram_activities table
    const { data: topUsers, error } = await supabase
      .from('telegram_activities')
      .select('total_xp, telegram_id')
      .order('total_xp', { ascending: false })
      .limit(10);
    
    console.log('📊 Leaderboard query result:', { data: topUsers, error });
    
    if (error) {
      console.error('❌ Error fetching leaderboard:', error);
      await sendMessageWithRateLimit(chatId, '❌ Error fetching leaderboard data.');
      return;
    }
    
    if (!topUsers || topUsers.length === 0) {
      // Send private connection message
      try {
        const privateMessage = `🔗 **Account Connection Required** 🔗

👋 **Hello!** You're not connected to our system yet.

📊 **Current Status:** ❌ Not Connected
💬 **Chat Activity:** ❌ No XP Rewards
🎁 **Daily Rewards:** ❌ Not Available

⚠️ **To view leaderboard and earn rewards:**
1️⃣ Visit: ${WEB_APP_URL}/telegram
2️⃣ Connect your wallet (MetaMask, etc.)
3️⃣ Click "Connect Telegram" button
4️⃣ Use Telegram Login Widget

💎 **After connection you'll get:**
• Real-time XP tracking
• Daily BBLP token rewards
• Level up notifications
• Community leaderboards

⚡ **Commands Available After Connection:**
/my_xp - Check your progress
/leaderboard - See top players
/help - Show all commands

🚀 **Connect now to start earning!**`;

        const keyboard = {
          inline_keyboard: [[
            {
              text: '🔗 Connect My Account',
              url: `${WEB_APP_URL}/telegram`
            }
          ]]
        };

        await bot.sendMessage(userId, privateMessage, {
          parse_mode: 'Markdown',
          reply_markup: keyboard
        });
        
        console.log(`📱 /leaderboard connection message sent to user ${userId}`);
        
        // Send public reminder
        await sendMessageWithRateLimit(chatId, `👋 ${userDisplayName} Please check your private messages from me to connect your wallet and view the leaderboard!`);
        
      } catch (error) {
        console.error(`❌ Error sending /leaderboard connection message:`, error);
      await sendMessageWithRateLimit(chatId, '📊 No leaderboard data available yet. Start chatting to earn XP!');
      }
      return;
    }
    
    // Get usernames for each user, but only include those registered in telegram_users
    const userPromises = topUsers.map(async (user) => {
      const { data: userInfo, error: userError } = await supabase
        .from('telegram_users')
        .select('username, first_name')
        .eq('telegram_id', user.telegram_id)
        .single();
      if (userError || !userInfo) return null; // Exclude if not registered
      return {
        ...user,
        username: userInfo.username || userInfo.first_name || 'Unknown User'
      };
    });
    const usersWithNames = (await Promise.all(userPromises)).filter(Boolean);

    let message = `🏆 Top 10 XP Leaderboard\n\n`;
    usersWithNames.forEach((user, index) => {
      const xpFormatted = (user.total_xp || 0).toLocaleString();
      const level = calculateLevel(user.total_xp);
      const emoji = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : '🏅';
      message += `${emoji} ${index + 1}. @${user.username} - ${xpFormatted} XP (Level ${level})\n`;
    });
    message += '\n💡 Keep chatting to earn more XP and climb the leaderboard!';
    await sendMessageWithRateLimit(chatId, message).then(sentMessage => {
      if (msg.chat.type === 'group' || msg.chat.type === 'supergroup') {
        setTimeout(async () => {
          try {
            await bot.deleteMessage(chatId, sentMessage.message_id);
            console.log(`🗑️ Deleted message ${sentMessage.message_id} after 15s`);
          } catch (e) {
            console.error(`❌ Failed to auto-delete message ${sentMessage.message_id}:`, e);
          }
        }, 15000);
      }
    });
    
  } catch (error) {
    console.error('❌ Error in /leaderboard command:', error);
    await sendMessageWithRateLimit(chatId, '❌ Error fetching leaderboard data.');
  }
});

bot.onText(/\/help/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  // Check if user is admin in this chat
  let isAdmin = false;
  try {
    const chatMember = await bot.getChatMember(chatId, userId);
    if (chatMember && (chatMember.status === 'creator' || chatMember.status === 'administrator')) {
      isAdmin = true;
    }
  } catch (e) { /* ignore errors, treat as not admin */ }

  let message = `🤖 <b>BBLIP Telegram Bot Help</b> 🤖\n\n<b>User Commands</b>\n/start — Connect your account\n/my_xp — View your XP & level\n/my_referral — Get your referral link\n/leaderboard — View top users\n/help — Show this help\n\n<b>How to Earn</b>\n• Chat to earn XP automatically\n• Invite friends for bonus rewards\n• Level up for bigger daily BBLP\n\n<i>Tip: Connect your wallet to unlock all features and maximize your rewards!</i>\n\nFor more info, visit <a href='https://bblip.io/social-connections'>bblip.io/social-connections</a>`;

  if (isAdmin) {
    message += `\n\n<b>Admin Commands</b>\n/ban, /unban, /restrict, /warn`;
  }

  await sendMessageWithRateLimit(chatId, message, { parse_mode: 'HTML' });
});

// Admin commands (Rose bot style)
bot.onText(/\/ban (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const adminId = msg.from.id;
  
  // Check if user is admin
  try {
    const chatMember = await bot.getChatMember(chatId, adminId);
    if (!['creator', 'administrator'].includes(chatMember.status)) {
      await sendMessageWithRateLimit(chatId, '❌ You need admin privileges to use this command.');
      return;
    }
  } catch (error) {
    console.error('Error checking admin status:', error);
    return;
  }
  
  const args = match[1].split(' ');
  const targetUser = args[0];
  const reason = args.slice(1).join(' ') || 'No reason provided';
  
  try {
    // Parse target user (username or user ID)
    let targetUserId;
    if (targetUser.startsWith('@')) {
      // Username
      const username = targetUser.substring(1);
      // Note: In a real implementation, you'd need to resolve username to user ID
      // For now, we'll use a placeholder
      targetUserId = username; // This would need proper resolution
    } else {
      // User ID
      targetUserId = parseInt(targetUser);
    }
    
    const banResult = await banUser(chatId, targetUserId, reason);
    
    if (banResult.success) {
      const banMessage = `🚫 User Banned\n\n` +
        `User: ${targetUser}\n` +
        `Reason: ${reason}\n` +
        `Type: ${banResult.type}\n` +
        `By: ${getUserDisplayName(msg)}`;
      
      await sendMessageWithRateLimit(chatId, banMessage);
    } else {
      await sendMessageWithRateLimit(chatId, `❌ Failed to ban user: ${banResult.error}`);
    }
  } catch (error) {
    console.error('Error in ban command:', error);
    await sendMessageWithRateLimit(chatId, '❌ Error processing ban command.');
  }
});

bot.onText(/\/unban (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const adminId = msg.from.id;
  
  // Check if user is admin
  try {
    const chatMember = await bot.getChatMember(chatId, adminId);
    if (!['creator', 'administrator'].includes(chatMember.status)) {
      await sendMessageWithRateLimit(chatId, '❌ You need admin privileges to use this command.');
      return;
    }
  } catch (error) {
    console.error('Error checking admin status:', error);
    return;
  }
  
  const targetUser = match[1];
  
  try {
    let targetUserId;
    if (targetUser.startsWith('@')) {
      const username = targetUser.substring(1);
      targetUserId = username; // This would need proper resolution
    } else {
      targetUserId = parseInt(targetUser);
    }
    
    const unbanResult = await unbanUser(chatId, targetUserId);
    
    if (unbanResult.success) {
      const unbanMessage = `🔓 User Unbanned\n\n` +
        `User: ${targetUser}\n` +
        `By: ${getUserDisplayName(msg)}`;
      
      await sendMessageWithRateLimit(chatId, unbanMessage);
    } else {
      await sendMessageWithRateLimit(chatId, `❌ Failed to unban user: ${unbanResult.error}`);
    }
  } catch (error) {
    console.error('Error in unban command:', error);
    await sendMessageWithRateLimit(chatId, '❌ Error processing unban command.');
  }
});

// Debug command for testing level up system (admin only)
bot.onText(/\/debug_level/, async (msg) => {
  const chatId = msg.chat.id;
  const adminId = msg.from.id;
  
  // Check if user is admin
  try {
    const chatMember = await bot.getChatMember(chatId, adminId);
    if (!['creator', 'administrator'].includes(chatMember.status)) {
      await sendMessageWithRateLimit(chatId, '❌ You need admin privileges to use this command.');
      return;
    }
  } catch (error) {
    console.error('Error checking admin status:', error);
    return;
  }
  
  try {
    console.log('🔍 Debug level up system...');
    
    // Get all users with their current levels
    const { data: activities, error } = await supabase
      .from('telegram_activities')
      .select('telegram_id, total_xp, current_level')
      .order('total_xp', { ascending: false })
      .limit(10);
    
    if (error) {
      console.error('Error fetching activities:', error);
      await sendMessageWithRateLimit(chatId, '❌ Error fetching user data.');
      return;
    }
    
    let debugMessage = `🔍 Level Up System Debug\n\n`;
    debugMessage += `📊 Top 10 users by XP:\n\n`;
    
    for (const activity of activities) {
      const calculatedLevel = calculateLevel(activity.total_xp);
      const levelName = getLevelName(calculatedLevel);
      const dbLevel = activity.current_level;
      const dbLevelName = getLevelName(dbLevel);
      
      debugMessage += `👤 User ${activity.telegram_id}:\n`;
      debugMessage += `  XP: ${activity.total_xp}\n`;
      debugMessage += `  DB Level: ${dbLevel} (${dbLevelName})\n`;
      debugMessage += `  Calculated: ${calculatedLevel} (${levelName})\n`;
      debugMessage += `  Status: ${calculatedLevel === dbLevel ? '✅ OK' : '⚠️ Mismatch'}\n\n`;
    }
    
    debugMessage += `🔄 Batch processing every 60 seconds\n`;
    debugMessage += `⚡ Real-time level detection: Enabled\n`;
    debugMessage += `📝 Cache size: ${messageCache.size} users\n`;
    debugMessage += `🔒 Processed messages: ${processedMessages.size}`;
    
    await sendMessageWithRateLimit(chatId, debugMessage);
    console.log('✅ Debug level up system completed');
    
  } catch (error) {
    console.error('❌ Error in debug_level command:', error);
    await sendMessageWithRateLimit(chatId, '❌ Error processing debug command.');
  }
});

// Admin stats command
bot.onText(/\/admin_stats/, async (msg) => {
  const chatId = msg.chat.id;
  const adminId = msg.from.id;
  
  // Check if user is admin
  try {
    const chatMember = await bot.getChatMember(chatId, adminId);
    if (!['creator', 'administrator'].includes(chatMember.status)) {
      await sendMessageWithRateLimit(chatId, '❌ You need admin privileges to use this command.');
      return;
    }
  } catch (error) {
    console.error('Error checking admin status:', error);
    return;
  }
  
  try {
    console.log('📊 Generating admin stats...');
    
    // Get database stats
    const { data: activities, error: activitiesError } = await supabase
      .from('telegram_activities')
      .select('total_xp, message_count');
    
    const { data: users, error: usersError } = await supabase
      .from('telegram_users')
      .select('telegram_id');
    
    if (activitiesError || usersError) {
      throw new Error('Database query failed');
    }
    
    const totalXP = activities.reduce((sum, activity) => sum + (activity.total_xp || 0), 0);
    const totalMessages = activities.reduce((sum, activity) => sum + (activity.message_count || 0), 0);
    const totalUsers = users.length;
    
    const stats = {
      cacheSize: messageCache.size,
      processedMessages: processedMessages.size,
      queueSize: messageQueue.length,
      activeUsers: userMessageHistory.size,
      totalMessages: totalMessages + messageCount,
      totalXP: totalXP
    };
    
    await sendAdminStats(stats);
    await sendMessageWithRateLimit(chatId, '✅ Admin stats sent to admin group');
    
  } catch (error) {
    console.error('❌ Error in admin_stats command:', error);
    await sendMessageWithRateLimit(chatId, '❌ Error generating admin stats.');
  }
});

// Admin log command
bot.onText(/\/admin_log (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const adminId = msg.from.id;
  const logMessage = match[1];
  
  // Check if user is admin
  try {
    const chatMember = await bot.getChatMember(chatId, adminId);
    if (!['creator', 'administrator'].includes(chatMember.status)) {
      await sendMessageWithRateLimit(chatId, '❌ You need admin privileges to use this command.');
      return;
    }
  } catch (error) {
    console.error('Error checking admin status:', error);
    return;
  }
  
  try {
    await sendAdminLog(logMessage, 'MANUAL');
    await sendMessageWithRateLimit(chatId, '✅ Log message sent to admin group');
  } catch (error) {
    console.error('❌ Error in admin_log command:', error);
    await sendMessageWithRateLimit(chatId, '❌ Error sending log message.');
  }
});

// Admin test command
bot.onText(/\/admin_test/, async (msg) => {
  const chatId = msg.chat.id;
  const adminId = msg.from.id;
  
  // Check if user is admin
  try {
    const chatMember = await bot.getChatMember(chatId, adminId);
    if (!['creator', 'administrator'].includes(chatMember.status)) {
      await sendMessageWithRateLimit(chatId, '❌ You need admin privileges to use this command.');
      return;
    }
  } catch (error) {
    console.error('Error checking admin status:', error);
    return;
  }
  
  try {
    // Check admin group ID
    if (!ADMIN_GROUP_ID || (!ADMIN_GROUP_ID.startsWith('-') && !ADMIN_GROUP_ID.startsWith('-100'))) {
      await sendMessageWithRateLimit(chatId, 
        `❌ Admin group not configured!\n\n` +
        `Current ID: ${ADMIN_GROUP_ID}\n` +
        `Required format: -xxxxxxxxx (normal group) or -100xxxxxxxxx (supergroup)\n\n` +
        `To fix:\n` +
        `1. Create a group or supergroup\n` +
        `2. Add bot as admin\n` +
        `3. Set TELEGRAM_ADMIN_GROUP_ID environment variable`
      );
      return;
    }
    
    await sendAdminLog('🧪 Admin test message - Bot is working correctly!', 'TEST');
    await sendMessageWithRateLimit(chatId, '✅ Test message sent to admin group');
  } catch (error) {
    console.error('❌ Error in admin_test command:', error);
    await sendMessageWithRateLimit(chatId, '❌ Error sending test message.');
  }
});

// Get group info command
bot.onText(/\/group_info/, async (msg) => {
  const chatId = msg.chat.id;
  const adminId = msg.from.id;
  
  // Check if user is admin
  try {
    const chatMember = await bot.getChatMember(chatId, adminId);
    if (!['creator', 'administrator'].includes(chatMember.status)) {
      await sendMessageWithRateLimit(chatId, '❌ You need admin privileges to use this command.');
      return;
    }
  } catch (error) {
    console.error('Error checking admin status:', error);
    return;
  }
  
  try {
    const chatInfo = await bot.getChat(chatId);
          const message = `📊 Group Information\n\n` +
        `🆔 Chat ID: ${chatInfo.id}\n` +
        `📝 Title: ${chatInfo.title || 'N/A'}\n` +
        `👥 Type: ${chatInfo.type}\n` +
        `👤 Username: @${chatInfo.username || 'N/A'}\n` +
        `📋 Description: ${chatInfo.description || 'N/A'}\n\n` +
        `💡 For Admin Group Setup:\n` +
        `• Current type: ${chatInfo.type}\n` +
        `• Current ID: ${chatInfo.id}\n` +
        `• Status: ${chatInfo.type === 'supergroup' ? '✅ Ready for admin logs' : '⚠️ Normal group (may upgrade to supergroup)'}\n\n` +
        `🔧 Environment Variable:\n` +
        `TELEGRAM_ADMIN_GROUP_ID=${chatInfo.id}\n\n` +
        `📝 Note: Both normal groups and supergroups work for admin logs.`;
    
    await sendMessageWithRateLimit(chatId, message);
  } catch (error) {
    console.error('❌ Error in group_info command:', error);
    await sendMessageWithRateLimit(chatId, '❌ Error getting group information.');
  }
});

// Test welcome message command
bot.onText(/\/test_welcome/, async (msg) => {
  const chatId = msg.chat.id;
  const adminId = msg.from.id;
  
  // Check if user is admin
  try {
    const chatMember = await bot.getChatMember(chatId, adminId);
    if (!['creator', 'administrator'].includes(chatMember.status)) {
      await sendMessageWithRateLimit(chatId, '❌ You need admin privileges to use this command.');
      return;
    }
  } catch (error) {
    console.error('Error checking admin status:', error);
    return;
  }
  
  try {
    console.log('🧪 Testing welcome message system...');
    
    // Simulate a new member join
    const testMember = {
      id: msg.from.id,
      username: msg.from.username || msg.from.first_name,
      first_name: msg.from.first_name,
      is_bot: false
    };
    
    await handleNewMember(chatId, testMember);
    await sendMessageWithRateLimit(chatId, '✅ Welcome message test completed');
    
  } catch (error) {
    console.error('❌ Error in test_welcome command:', error);
    await sendMessageWithRateLimit(chatId, '❌ Error testing welcome message.');
  }
});

// Referral command
bot.onText(/\/my_referral/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const userDisplayName = getUserDisplayName(msg);
  
  try {
    console.log(`🔗 /my_referral command from ${userDisplayName} (${userId})`);
    
    // Check if user is connected
    const { data: telegramUser, error } = await supabase
      .from('telegram_users')
      .select('*')
      .eq('telegram_id', userId)
      .single();
    
    if (error || !telegramUser) {
      // Send private connection message
      try {
        const privateMessage = `🔗 <b>Connect Wallet to Get Your Referral Link</b>\n\n👋 <b>Hello!</b> To get your referral link and start earning BBLP rewards, please connect your wallet.\n\n<b>Status:</b> ❌ Not Connected\n<b>Referral Link:</b> ❌ Not Available\n<b>BBLP Rewards:</b> ❌ Not Available\n\n<b>How to Connect:</b>\n1️⃣ Visit: <a href='https://bblip.io/social-connections'>bblip.io/social-connections</a>\n2️⃣ Connect your wallet (MetaMask, etc.)\n3️⃣ Click "Connect Telegram"\n\n<b>After connecting, you'll get:</b>\n• Your personal referral link\n• XP & BBLP rewards for each referral\n• Daily BBLP token rewards\n\n🚀 <b>Connect now to unlock your rewards!</b>`;
        const keyboard = {
          inline_keyboard: [[
            {
              text: '🔗 Connect Wallet',
              url: 'https://bblip.io/social-connections'
            }
          ]]
        };
        await bot.sendMessage(userId, privateMessage, {
          parse_mode: 'HTML',
          reply_markup: keyboard
        });
        
        console.log(`📱 /my_referral connection message sent to user ${userId}`);
        
        // Send public reminder
        await sendMessageWithRateLimit(chatId, `👋 ${userDisplayName} Please check your private messages from me to connect your wallet and get your referral link!`);
        
      } catch (error) {
        console.error(`❌ Error sending /my_referral connection message:`, error);
        await sendMessageWithRateLimit(chatId, 'You need to connect your wallet first. Visit our web app to connect.');
      }
      return;
    }
    
    // Get user's referral stats
    const { data: activity, error: activityError } = await supabase
      .from('telegram_activities')
      .select('referral_count, total_xp')
      .eq('telegram_id', userId)
      .single();
    
    const referralCount = activity?.referral_count || 0;
    const totalXP = activity?.total_xp || 0;
    
    // Get or create referral link
    const referralLink = await generateReferralLink(userId);
    
    if (!referralLink) {
      await sendMessageWithRateLimit(chatId, '❌ Error getting referral link. Please try again later.');
      return;
    }
    
    // Güçlü MarkdownV2 kaçış fonksiyonu
    function escapeMarkdownV2(text) {
      return String(text)
        .replace(/([_\*\[\]\(\)~`>#+\-=|{}.!\\])/g, '\\$1');
    }

    const safeUserDisplayName = escapeMarkdownV2(userDisplayName);
    const safeReferralLink = escapeMarkdownV2(referralLink);
    const safeXP = escapeMarkdownV2(REFERRAL_XP_REWARD);
    const safeBBLP = escapeMarkdownV2(REFERRAL_BBLP_REWARD);

    // Escape all message lines for MarkdownV2
    const messageLines = [
      '🚀 *Invite & Earn Rewards!*',
      '',
      `Hi ${safeUserDisplayName}! Here\'s your unique invite link:`,
      '',
      '➡️',
      `${safeReferralLink}`,
      '',
      '🎁 *What You Get:*',
      `• +${safeXP} XP for every friend who joins`,
      `• +${safeBBLP} BBLP tokens per referral`,
      '• Track your progress and climb the leaderboard!',
      '',
      '💡 *How it works:*',
      '1️⃣ Share your link with friends (use the Share or Copy button below)',
      '2️⃣ They click the link, start the bot, and join our group',
      '3️⃣ You both get rewarded instantly!',
      '',
      '📈 *Tip:* The more you share, the more you earn!',
      '',
      '*Note: Your friend must start the bot and join the group for your reward to be counted.*'
    ];
    // Escape each line for MarkdownV2
    const safeMessage = messageLines.map(escapeMarkdownV2).join('\n');

    const shareMessage = `🚀 Join me on BBLIP and unlock exclusive crypto rewards!\n\n💰 $100,000 Prize Pool! 💰\n\nBBLIP is the next-gen platform to earn, spend, and grow your crypto with real utility.\n\n👉 Tap the link to get started:\n${referralLink}\n\nWhy join?\n• Earn daily BBLP token rewards\n• Level up for bigger bonuses\n• Compete on the leaderboard\n• Invite friends and multiply your earnings!\n• Win a share of the $100,000 prize pool!\n\nLet's grow together in the BBLIP community!`;

    const keyboard = {
      inline_keyboard: [
        [
          {
            text: '📤 Share Referral Link',
            url: `https://t.me/share/url?url=&text=${encodeURIComponent(shareMessage)}`
          }
        ]
      ]
    };

    // Callback handler'ı globalde bir kez tanımla
    if (!global.__copyReferralHandlerSet) {
      bot.on('callback_query', async (callbackQuery) => {
        if (callbackQuery.data && callbackQuery.data === 'copy_referral_link') {
          const chatId = callbackQuery.message.chat.id;
          // Look up the referral link for this user
          const userId = callbackQuery.from.id;
          // Get or create referral link for this user
          const referralLink = await generateReferralLink(userId);
          await bot.answerCallbackQuery(callbackQuery.id, { text: 'Referans linkin aşağıda!', show_alert: false });
          await bot.sendMessage(
            chatId,
            `📋 Referans linkin:\n${referralLink}\n\nKopyalamak için linke uzun bas ve 'Kopyala'ya tıkla.`,
          );
        }
      });
      global.__copyReferralHandlerSet = true;
    }

    // Only send the referral message as a private message to the user
    if (msg.chat.type === 'private') {
      await sendMessageWithRateLimit(chatId, safeMessage, {
        parse_mode: 'MarkdownV2',
        reply_markup: keyboard
      });
    }
    
  } catch (error) {
    console.error('❌ Error in /my_referral command:', error);
    await sendMessageWithRateLimit(chatId, '❌ Error getting referral link. Please try again later.');
  }
});

// Auto-delete configuration command
bot.onText(/\/auto_delete/, async (msg) => {
  const chatId = msg.chat.id;
  const adminId = msg.from.id;
  
  // Check if user is admin
  try {
    const chatMember = await bot.getChatMember(chatId, adminId);
    if (!['creator', 'administrator'].includes(chatMember.status)) {
      await sendMessageWithRateLimit(chatId, '❌ You need admin privileges to use this command.');
      return;
    }
  } catch (error) {
    console.error('Error checking admin status:', error);
    return;
  }
  
  try {
    const message = `🗑️ Auto-Delete Configuration\n\n` +
      `Current Status: ${WELCOME_MESSAGE_DELETE_ENABLED ? '✅ Enabled' : '❌ Disabled'}\n` +
      `Delete Delay: ${WELCOME_MESSAGE_DELETE_DELAY/1000} seconds\n\n` +
      `To change settings, modify these variables in bot.js:\n` +
      `• WELCOME_MESSAGE_DELETE_ENABLED: true/false\n` +
      `• WELCOME_MESSAGE_DELETE_DELAY: ${WELCOME_MESSAGE_DELETE_DELAY}ms\n\n` +
      `📝 Note: Changes require bot restart`;
    
    await sendMessageWithRateLimit(chatId, message);
  } catch (error) {
    console.error('❌ Error in auto_delete command:', error);
    await sendMessageWithRateLimit(chatId, '❌ Error getting auto-delete configuration.');
  }
});

// Test referral system command
bot.onText(/\/test_referral/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  // Check if user is admin
  try {
    const chatMember = await bot.getChatMember(chatId, userId);
    if (!chatMember || (chatMember.status !== 'creator' && chatMember.status !== 'administrator')) {
      return; // Not admin, ignore
    }
  } catch (error) {
    console.error('Error checking admin status:', error);
    return;
  }
  
  try {
    // Generate a test referral link
    const referralData = await generateReferralLink(userId);
    
    if (!referralData) {
      await sendMessageWithRateLimit(chatId, '❌ Error generating test referral link');
      return;
    }
    
    const message = `🧪 **Referral System Test** 🧪

🔗 **Test Referral Link Generated:**
${referralData.inviteLink}

📝 **Referral Code:** \`${referralData.referralCode}\`

🧪 **Test Instructions:**
1️⃣ Copy the link above
2️⃣ Open in a new browser/device
3️⃣ Click the link to go to bot first
4️⃣ Bot should process referral and redirect to group
5️⃣ Check if referral is processed

📊 **Expected Result:**
• User should go to bot first
• Bot should process referral automatically
• User should get redirected to group
• You should receive a notification
• Your referral count should increase

🔧 **Debug Info:**
• Link Format: Bot deep link with referral code
• Processing: Via /start command in bot
• Database tracking: Enabled`;

    const keyboard = {
      inline_keyboard: [[
        {
          text: '🧪 Test Referral Link',
          url: referralData.inviteLink
        }
      ]]
    };

    await bot.sendMessage(chatId, message, {
      parse_mode: 'Markdown',
      reply_markup: keyboard
    });
    
  } catch (error) {
    console.error('Error in test referral command:', error);
    await sendMessageWithRateLimit(chatId, '❌ Error testing referral system');
  }
});

// Referral statistics command
bot.onText(/\/referral_stats/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const username = msg.from.username || msg.from.first_name;
  
  // Check if user is admin
  try {
    const chatMember = await bot.getChatMember(chatId, userId);
    if (!chatMember || (chatMember.status !== 'creator' && chatMember.status !== 'administrator')) {
      return; // Not admin, ignore
    }
  } catch (error) {
    console.error('Error checking admin status:', error);
    return;
  }
  
  try {
    console.log(`📊 Admin ${userId} requesting referral statistics...`);
    
    // Get referral join statistics
    const { data: joinStats, error: joinError } = await supabase
      .from('telegram_referral_joins')
      .select('*');
    
    if (joinError) {
      console.error(`❌ Error fetching referral join stats:`, joinError);
      await bot.sendMessage(chatId, `❌ Error fetching referral statistics: ${joinError.message}`);
      return;
    }
    
    // Get referral attempt statistics
    const { data: attemptStats, error: attemptError } = await supabase
      .from('telegram_referral_attempts')
      .select('*');
    
    if (attemptError) {
      console.error(`❌ Error fetching referral attempt stats:`, attemptError);
      await bot.sendMessage(chatId, `❌ Error fetching referral attempt statistics: ${attemptError.message}`);
      return;
    }
    
    // Calculate statistics
    const totalJoins = joinStats.length;
    const successfulJoins = joinStats.filter(j => j.join_status === 'completed').length;
    const pendingJoins = joinStats.filter(j => j.join_status === 'pending').length;
    const failedJoins = joinStats.filter(j => j.join_status === 'failed').length;
    
    const totalAttempts = attemptStats.length;
    const successfulAttempts = attemptStats.filter(a => a.attempt_status === 'success').length;
    const failedAttempts = attemptStats.filter(a => a.attempt_status === 'failed').length;
    const blockedAttempts = attemptStats.filter(a => a.attempt_status === 'blocked').length;
    
    // Get top referrers
    const referrerCounts = {};
    joinStats.forEach(join => {
      if (join.join_status === 'completed') {
        referrerCounts[join.referrer_id] = (referrerCounts[join.referrer_id] || 0) + 1;
      }
    });
    
    const topReferrers = Object.entries(referrerCounts)
      .sort(([,a], [,b]) => b - a)
      .slice(0, 5);
    
    const statsMessage = `📊 **Referral System Statistics** 📊

🎯 **Join Statistics:**
• Total Joins: ${totalJoins}
• Successful: ${successfulJoins}
• Pending: ${pendingJoins}
• Failed: ${failedJoins}

📈 **Attempt Statistics:**
• Total Attempts: ${totalAttempts}
• Successful: ${successfulAttempts}
• Failed: ${failedAttempts}
• Blocked: ${blockedAttempts}

🏆 **Top Referrers:**
${topReferrers.map(([id, count], index) => `${index + 1}. User ${id}: ${count} referrals`).join('\n')}

📅 **Last 24 Hours:**
• New Joins: ${joinStats.filter(j => new Date(j.created_at) > new Date(Date.now() - 24*60*60*1000)).length}
• New Attempts: ${attemptStats.filter(a => new Date(a.created_at) > new Date(Date.now() - 24*60*60*1000)).length}`;
    
    await bot.sendMessage(chatId, statsMessage, { parse_mode: 'Markdown' });
    console.log(`✅ Referral statistics sent to admin ${userId}`);
    
  } catch (error) {
    console.error(`❌ Error in referral stats:`, error);
    await bot.sendMessage(chatId, `❌ Error getting referral statistics: ${error.message}`);
  }
});

// Handle all messages (ULTRA-OPTIMIZED - Fast processing with Anti-Bot protection)
bot.on('message', async (msg) => {
  // Hide left_chat_member (user left) messages in the main group
  if (msg.left_chat_member && msg.chat && msg.chat.id && msg.chat.id.toString() === GROUP_ID) {
    try {
      await bot.deleteMessage(msg.chat.id, msg.message_id);
      console.log(`🗑️ Deleted left_chat_member message for user ${msg.left_chat_member.id}`);
    } catch (error) {
      console.error('❌ Error deleting left_chat_member message:', error);
    }
    return; // Do not process further
  }
  // Check if this is a new chat members message (Rose bot style)
  if (msg.new_chat_members && msg.new_chat_members.length > 0) {
    const chatId = msg.chat.id;
    
    // Only process in our main group
    if (chatId.toString() !== GROUP_ID) {
      return;
    }
    
    console.log(`👋 New chat members detected:`, msg.new_chat_members.length);
    console.log(`📝 Join message text: "${msg.text || 'No text'}"`);
    console.log(`🔗 Join message entities:`, JSON.stringify(msg.entities || []));
    
    // Check for referral code in the join message
    let referralCode = null;
    
    // Check different possible formats for referral codes
    if (msg.text) {
      // Format 1: ?start=REF123456_1234567890
      const startMatch = msg.text.match(/\?start=([^\s]+)/);
      if (startMatch) {
        referralCode = startMatch[1];
        console.log(`🔗 Referral code detected in join message (format 1): ${referralCode}`);
      }
      
      // Format 2: /start REF123456_1234567890
      if (!referralCode) {
        const startCommandMatch = msg.text.match(/\/start\s+([^\s]+)/);
        if (startCommandMatch) {
          referralCode = startCommandMatch[1];
          console.log(`🔗 Referral code detected in join message (format 2): ${referralCode}`);
        }
      }
      
      // Format 3: Check if the entire message is a referral code
      if (!referralCode && msg.text.startsWith('REF') && msg.text.includes('_')) {
        referralCode = msg.text;
        console.log(`🔗 Referral code detected in join message (format 3): ${referralCode}`);
      }
      
      // Format 4: Check for URL entities that might contain referral codes
      if (!referralCode && msg.entities) {
        for (const entity of msg.entities) {
          if (entity.type === 'url' || entity.type === 'text_link') {
            const url = entity.type === 'url' ? 
              msg.text.substring(entity.offset, entity.offset + entity.length) :
              entity.url;
            
            console.log(`🔍 Checking URL entity: ${url}`);
            
            // Extract referral code from URL
            const urlStartMatch = url.match(/[?&]start=([^&]+)/);
            if (urlStartMatch) {
              referralCode = urlStartMatch[1];
              console.log(`🔗 Referral code detected in URL entity: ${referralCode}`);
              break;
            }
          }
        }
      }
    }
    
    for (const newMember of msg.new_chat_members) {
      // Skip if the new member is the bot itself
      if (newMember.is_bot && newMember.username === 'denemebot45bot') {
        console.log(`🤖 Bot joined, skipping welcome message`);
        continue;
      }
      
      // Store referral code for this user if found
      if (referralCode) {
        pendingReferrals.set(newMember.id, referralCode);
        console.log(`📝 Stored referral code ${referralCode} for user ${newMember.id}`);
      } else {
        console.log(`⚠️ No referral code found for user ${newMember.id}`);
      }
      
      await handleNewMember(chatId, newMember);
    }
    
    // Return early to avoid processing as regular message
    return;
  }
  
  // Only process messages from the main group
  if (msg.chat.id.toString() !== GROUP_ID) {
    return;
  }
  
  const userId = msg.from.id;
  const messageId = msg.message_id;
  const messageText = msg.text || '';
  const userDisplayName = getUserDisplayName(msg);
  
  // Create unique message identifier
  const messageKey = `${userId}_${messageId}_${msg.chat.id}`;
  
  // Quick duplicate check first (before any async operations)
  if (processedMessages.has(messageKey)) {
    return; // Skip silently for performance
  }
  
  // Anti-bot protection checks - BAN CHECK FIRST (STRICT)
  if (isUserBanned(userId)) {
    console.log(`🚫 Banned user ${userDisplayName} (${userId}) tried to send message, ignoring`);
    
    // Send warning to banned user
    try {
      const userData = userMessageHistory.get(userId);
      const remainingTime = Math.ceil((userData.bannedUntil - Date.now()) / 1000);
      
      const banWarningMessage = `🚫 You are currently banned\n\n` +
        `You cannot send messages for ${remainingTime} more seconds due to rule violations.\n` +
        `Please wait and try again later.\n\n` +
        `⚠️ Warnings: ${userData.warnings}/${ANTI_BOT_CONFIG.WARNING_THRESHOLD}`;
      
      await sendMessageWithRateLimit(msg.chat.id, banWarningMessage);
    } catch (error) {
      console.error('Error sending ban warning to user:', error);
    }
    
    // IMPORTANT: Don't add to processedMessages, don't process further
    return;
  }
  
  // Check message rate
  const rateCheck = checkMessageRate(userId);
  if (!rateCheck.allowed) {
    console.log(`⚠️ Rate limit exceeded for user ${userDisplayName} (${userId}): ${rateCheck.reason}`);
    const spamResult = await handleSpamDetection(msg, userId, rateCheck.reason);
    
    if (spamResult.action === 'restrict' || spamResult.action === 'ban') {
      // Restriction/ban already handled in handleSpamDetection
      return;
    }
  }
  
  // Check for spam patterns
  if (isSpamMessage(messageText)) {
    console.log(`🚨 Spam detected for user ${userDisplayName} (${userId}): "${messageText}"`);
    const spamResult = await handleSpamDetection(msg, userId, 'spam_pattern');
    
    if (spamResult.action === 'restrict' || spamResult.action === 'ban') {
      // Restriction/ban already handled in handleSpamDetection
      return;
    }
  }
  
  // Mark as processed immediately to prevent race conditions
  processedMessages.set(messageKey, true);
  
  // Performance monitoring
  messageCount++;
  const currentTime = Date.now();
  const timeSinceLastMessage = currentTime - lastMessageTime;
  lastMessageTime = currentTime;
  
  // Log performance every 100 messages
  if (messageCount % PERFORMANCE_LOG_INTERVAL === 0) {
    console.log(`📊 Performance Stats: ${messageCount} messages processed`);
    console.log(`  - Time since last message: ${timeSinceLastMessage}ms`);
    console.log(`  - Cache size: ${messageCache.size} users`);
    console.log(`  - Processed messages: ${processedMessages.size}`);
    console.log(`  - Queue size: ${messageQueue.length}`);
    console.log(`  - Active users: ${userMessageHistory.size}`);
  }
  
  console.log('📨 Message received:', {
    userId,
    userDisplayName,
    messageId,
    messageKey,
    messageType: msg.photo ? 'photo' : 'text'
  });
  
  // Process message asynchronously without blocking
  processMessageAsync(msg, messageKey, userId, messageText, userDisplayName).catch(error => {
    console.error('❌ Error in async message processing:', error);
  });
});

// Async message processing function
async function processMessageAsync(msg, messageKey, userId, messageText, userDisplayName) {
  try {
    // Use optimized message processing
    await processMessageOptimized(msg, messageKey, userId, messageText, userDisplayName);
    
    // Check if user is connected (with timeout and circuit breaker)
    const userCheckPromise = dbCircuitBreaker.execute(async () => {
      return await supabase
        .from('telegram_users')
        .select('*')
        .eq('telegram_id', userId)
        .single();
    });
    
    // Add timeout to prevent hanging
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('User check timeout')), 3000)
    );
    
    const { data: telegramUser, error: userError } = await Promise.race([
      userCheckPromise,
      timeoutPromise
    ]);
    
    if (userError || !telegramUser) {
      // User not connected, remove from processed set
      processedMessages.delete(messageKey);
      
      // Send private connection reminder (only once per session to avoid spam)
      const connectionReminderKey = `connection_reminder_${userId}`;
      if (!processedMessages.has(connectionReminderKey)) {
        try {
          const reminderMessage = `⚠️ <b>Account Not Connected</b> ⚠️\n\n👋 <b>Hello!</b> I noticed you're chatting but your account isn't connected to our system.\n\n<b>Status:</b> ❌ Not Connected\n<b>Chat Activity:</b> ❌ No XP Rewards\n<b>Daily Rewards:</b> ❌ Not Available\n\n<b>How to Connect:</b>\n1️⃣ Visit: <a href='https://bblip.io/social-connections'>bblip.io/social-connections</a>\n2️⃣ Connect your wallet (MetaMask, etc.)\n3️⃣ Click "Connect Telegram"\n\n<b>After connecting, you'll get:</b>\n• XP for every message\n• Daily BBLP rewards\n• Level up notifications\n• Community leaderboards\n\n🚀 <b>Connect now to start earning!</b>`;
          const keyboard = {
            inline_keyboard: [[
              {
                text: '🔗 Connect Wallet',
                url: 'https://bblip.io/social-connections'
              }
            ]]
          };
          await bot.sendMessage(userId, reminderMessage, {
            parse_mode: 'HTML',
            reply_markup: keyboard
          });
          
          console.log(`📱 Connection reminder sent to @${userDisplayName} (${userId})`);
          
          // Mark as sent to avoid spam
          processedMessages.set(connectionReminderKey, true);
          
          // Remove reminder key after 1 hour to allow future reminders
          setTimeout(() => {
            processedMessages.delete(connectionReminderKey);
          }, 60 * 60 * 1000); // 1 hour
          
        } catch (error) {
          console.error(`❌ Error sending connection reminder to @${userDisplayName}:`, error);
        }
      }
      
      return;
    }
    
    // Calculate XP for this message
    const xpEarned = XP_REWARDS.MESSAGE; // Faydalı mesaj XP'si kaldırıldı
    
    // Get current user activity to check level up (with circuit breaker)
    const { data: currentActivity, error: activityError } = await dbCircuitBreaker.execute(async () => {
      return await supabase
        .from('telegram_activities')
        .select('total_xp, current_level')
        .eq('telegram_id', userId)
        .single();
    });
    
    let oldLevel = 1;
    let currentTotalXP = 0;
    
    if (!activityError && currentActivity) {
      oldLevel = currentActivity.current_level;
      currentTotalXP = currentActivity.total_xp;
    }
    
    // Update cache atomically (optimized)
    let cached = messageCache.get(userId);
    if (cached) {
      cached.messageCount += 1;
      cached.xpEarned += xpEarned;
      cached.lastUpdate = Date.now();
      cached.processedMessages.add(messageKey);
    } else {
      cached = {
        messageCount: 1,
        xpEarned: xpEarned,
        lastUpdate: Date.now(),
        processedMessages: new Set([messageKey])
      };
      messageCache.set(userId, cached);
    }
    
    // Check for real-time level up (including cache)
    const newTotalXP = currentTotalXP + cached.xpEarned;
    const newLevel = calculateLevel(newTotalXP);
    
    console.log(`📊 Cache updated for user ${userDisplayName} (${userId}):`, {
      messageCount: cached.messageCount,
      xpEarned: cached.xpEarned,
      processedMessages: cached.processedMessages.size,
      oldLevel,
      newLevel,
      currentTotalXP,
      newTotalXP
    });
    
    // Check for real-time level up
    if (newLevel > oldLevel) {
      console.log(`🎉 REAL-TIME LEVEL UP detected for user ${userDisplayName} (${userId}): ${oldLevel} → ${newLevel}`);
      
      // Get user info for notification
      const { data: userInfo, error: userError } = await supabase
        .from('telegram_users')
        .select('username, first_name')
        .eq('telegram_id', userId)
        .single();
      
      if (!userError && userInfo) {
        const username = userInfo.username || userInfo.first_name;
        const levelName = getLevelName(newLevel);
        const oldLevelName = getLevelName(oldLevel);
        const newReward = getLevelReward(newLevel);
        
        const levelUpMessage = `🎉 **REAL-TIME LEVEL UP!** 🎉\n\n` +
          `Congratulations @${username}! 🏆\n\n` +
          `You've leveled up from **${oldLevelName}** to **${levelName}**!\n` +
          `⭐ Total XP: ${newTotalXP} (including pending)\n` +
          `💬 Messages: ${currentActivity?.message_count + cached.messageCount || cached.messageCount}\n\n` +
          `🎁 Daily Reward: ${newReward} BBLP/day\n\n` +
          `⚡ This is a real-time level up! Your XP will be saved in the next batch.`;
        
        // Send notification to group
        try {
          await sendMessageWithRateLimit(GROUP_ID, levelUpMessage);
          console.log(`✅ Real-time level up notification sent for user ${userDisplayName}: ${oldLevelName} → ${levelName}`);
          
          // Send to admin group
          await sendAdminLog(
            `🎉 Real-Time Level Up\n\n` +
            `User: @${username} (${userId})\n` +
            `Level: ${oldLevelName} → ${levelName}\n` +
            `XP: ${currentTotalXP} → ${newTotalXP}\n` +
            `Reward: ${newReward} BBLP/day`,
            'LEVEL_UP'
          );
        } catch (error) {
          console.error('❌ Error sending real-time level up notification:', error);
          console.error('Error details:', JSON.stringify(error, null, 2));
          await sendAdminError(error, 'Real-time level up notification');
        }
      } else {
        console.log(`⚠️ Could not get user info for real-time level up notification: ${userError || 'No user data'}`);
      }
    }
    
  } catch (error) {
    console.error('❌ Error processing message:', error);
    // Remove from processed set on error
    processedMessages.delete(messageKey);
  }
}

// Helper functions
function isHelpfulMessage(text) {
  const helpfulKeywords = [
    'help', 'how', 'what', 'where', 'when', 'why', 'guide', 'tutorial',
    'explain', 'assist', 'support', 'answer', 'question', 'problem',
    'solution', 'advice', 'tip', 'recommend', 'suggest'
  ];
  
  const lowerText = text.toLowerCase();
  return helpfulKeywords.some(keyword => lowerText.includes(keyword));
}

// Anti-bot protection functions
function isSpamMessage(text) {
  if (!text || text.length < 3) return false;
  
  // Check for suspicious patterns
  return ANTI_BOT_CONFIG.SUSPICIOUS_PATTERNS.some(pattern => pattern.test(text));
}

function isUserBanned(userId) {
  const userData = userMessageHistory.get(userId);
  if (!userData || !userData.bannedUntil) return false;
  
  const now = Date.now();
  
  if (now > userData.bannedUntil) {
    // Ban expired, remove it
    userData.bannedUntil = null;
    userData.warnings = Math.max(0, userData.warnings - 1); // Reduce warnings
    userMessageHistory.set(userId, userData);
    console.log(`✅ Ban expired for user ${userId}, warnings reduced to ${userData.warnings}`);
    return false;
  }
  
  // Calculate remaining ban time
  const remainingTime = Math.ceil((userData.bannedUntil - now) / 1000);
  console.log(`🚫 User ${userId} still banned for ${remainingTime} seconds`);
  return true;
}

// Telegram ban/unban functions (Rose bot style)
async function banUser(chatId, userId, reason = 'Spam/Abuse', duration = 0) {
  try {
    console.log(`🔨 Banning user ${userId} from chat ${chatId} for reason: ${reason}`);
    
    if (duration > 0) {
      // Temporary ban (until_date)
      const untilDate = Math.floor(Date.now() / 1000) + duration;
      await bot.banChatMember(chatId, userId, { until_date: untilDate });
      console.log(`⏰ User ${userId} temporarily banned until ${new Date(untilDate * 1000)}`);
    } else {
      // Permanent ban
      await bot.banChatMember(chatId, userId);
      console.log(`🚫 User ${userId} permanently banned`);
    }
    
    return { success: true, type: duration > 0 ? 'temporary' : 'permanent' };
  } catch (error) {
    console.error(`❌ Error banning user ${userId}:`, error);
    return { success: false, error: error.message };
  }
}

async function unbanUser(chatId, userId) {
  try {
    console.log(`🔓 Unbanning user ${userId} from chat ${chatId}`);
    await bot.unbanChatMember(chatId, userId, { only_if_banned: true });
    console.log(`✅ User ${userId} unbanned successfully`);
    return { success: true };
  } catch (error) {
    console.error(`❌ Error unbanning user ${userId}:`, error);
    return { success: false, error: error.message };
  }
}

async function restrictUser(chatId, userId, duration = 300) {
  try {
    console.log(`🔒 Restricting user ${userId} in chat ${chatId} for ${duration} seconds`);
    
    const permissions = {
      can_send_messages: false,
      can_send_media_messages: false,
      can_send_other_messages: false,
      can_add_web_page_previews: false
    };
    
    const untilDate = Math.floor(Date.now() / 1000) + duration;
    await bot.restrictChatMember(chatId, userId, { 
      permissions: permissions,
      until_date: untilDate 
    });
    
    console.log(`🔒 User ${userId} restricted until ${new Date(untilDate * 1000)}`);
    return { success: true, until_date: untilDate };
  } catch (error) {
    console.error(`❌ Error restricting user ${userId}:`, error);
    return { success: false, error: error.message };
  }
}

// Get user display name (username or first_name)
function getUserDisplayName(msg) {
  const username = msg.from.username;
  const firstName = msg.from.first_name;
  const lastName = msg.from.last_name;
  
  if (username) {
    return `@${username}`;
  } else if (firstName && lastName) {
    return `${firstName} ${lastName}`;
  } else if (firstName) {
    return firstName;
  } else {
    return `User${msg.from.id}`;
  }
}

function checkMessageRate(userId) {
  const now = Date.now();
  const userData = userMessageHistory.get(userId) || { messages: [], warnings: 0, bannedUntil: null };
  
  // Add current message
  userData.messages.push(now);
  
  // Remove old messages (older than 1 hour)
  userData.messages = userData.messages.filter(time => now - time < 3600000);
  
  // Check minute rate
  const messagesLastMinute = userData.messages.filter(time => now - time < 60000).length;
  if (messagesLastMinute > ANTI_BOT_CONFIG.MAX_MESSAGES_PER_MINUTE) {
    return { allowed: false, reason: 'minute_rate', count: messagesLastMinute };
  }
  
  // Check hour rate
  const messagesLastHour = userData.messages.length;
  if (messagesLastHour > ANTI_BOT_CONFIG.MAX_MESSAGES_PER_HOUR) {
    return { allowed: false, reason: 'hour_rate', count: messagesLastHour };
  }
  
  // Check minimum interval
  if (userData.messages.length > 1) {
    const lastMessageTime = userData.messages[userData.messages.length - 2];
    const interval = now - lastMessageTime;
    if (interval < ANTI_BOT_CONFIG.MIN_MESSAGE_INTERVAL) {
      return { allowed: false, reason: 'min_interval', interval };
    }
  }
  
  userMessageHistory.set(userId, userData);
  return { allowed: true };
}

async function handleSpamDetection(msg, userId, reason) {
  const userData = userMessageHistory.get(userId) || { messages: [], warnings: 0, bannedUntil: null, restrictedUntil: null };
  const spamData = spamDetections.get(userId) || { count: 0, lastDetection: null };
  const userDisplayName = getUserDisplayName(msg);
  
  const now = Date.now();
  
  // Check if this is a recent detection
  if (spamData.lastDetection && now - spamData.lastDetection < ANTI_BOT_CONFIG.SPAM_DETECTION_WINDOW) {
    spamData.count++;
  } else {
    spamData.count = 1;
  }
  
  spamData.lastDetection = now;
  spamDetections.set(userId, spamData);
  
  // Increment warnings
  userData.warnings++;
  
  // Check if user should be restricted (Rose bot style)
  if (userData.warnings >= ANTI_BOT_CONFIG.WARNING_THRESHOLD) {
    if (ANTI_BOT_CONFIG.USE_TELEGRAM_RESTRICTIONS) {
      // Use Telegram's native restriction
      const restrictResult = await restrictUser(msg.chat.id, userId, ANTI_BOT_CONFIG.RESTRICT_DURATION);
      
      if (restrictResult.success) {
        userData.restrictedUntil = restrictResult.until_date * 1000;
        userData.warnings = 0; // Reset warnings after restriction
        userMessageHistory.set(userId, userData);
        
        console.log(`🔒 User ${userDisplayName} (${userId}) restricted for ${ANTI_BOT_CONFIG.RESTRICT_DURATION} seconds`);
        
        // Send restriction notification to group
        const restrictMessage = `🔒 *Anti-Bot Protection*\n\n` +
          `${userDisplayName} has been restricted for ${ANTI_BOT_CONFIG.RESTRICT_DURATION} seconds due to rule violations.\n` +
          `They cannot send messages during this time.`;
        
        try {
          await sendMessageWithRateLimit(msg.chat.id, restrictMessage);
        } catch (error) {
          console.error('Error sending restriction notification:', error);
        }
        
        return { action: 'restrict', duration: ANTI_BOT_CONFIG.RESTRICT_DURATION };
      }
    } else {
      // Fallback to internal ban
      userData.bannedUntil = now + ANTI_BOT_CONFIG.BAN_DURATION;
      userMessageHistory.set(userId, userData);
      
      console.log(`🚫 User ${userDisplayName} (${userId}) banned for ${ANTI_BOT_CONFIG.BAN_DURATION/1000} seconds due to spam`);
      return { action: 'ban', duration: ANTI_BOT_CONFIG.BAN_DURATION };
    }
  }
  
  userMessageHistory.set(userId, userData);
  console.log(`⚠️ User ${userDisplayName} (${userId}) warning ${userData.warnings}/${ANTI_BOT_CONFIG.WARNING_THRESHOLD} - Reason: ${reason}`);
  return { action: 'warning', warnings: userData.warnings };
}

// Rate limiting functions
async function sendMessageWithRateLimit(chatId, message, options = {}) {
  return new Promise((resolve, reject) => {
    messageQueue.push({
      chatId,
      message,
      options,
      resolve,
      reject,
      timestamp: Date.now()
    });
    
    if (!isProcessingQueue) {
      processMessageQueue();
    }
  });
}

// Admin log functions
async function sendAdminLog(message, type = 'INFO') {
  try {
    // Check if admin group ID is valid (can be normal group or supergroup)
    if (!ADMIN_GROUP_ID || (!ADMIN_GROUP_ID.startsWith('-') && !ADMIN_GROUP_ID.startsWith('-100'))) {
      console.log(`⚠️ Invalid admin group ID: ${ADMIN_GROUP_ID}. Admin logs disabled.`);
      return;
    }
    
    const timestamp = new Date().toLocaleString('tr-TR');
    const logMessage = `📊 ${type} - ${timestamp}\n\n${message}`;
    
    await sendMessageWithRateLimit(ADMIN_GROUP_ID, logMessage);
    console.log(`📤 Admin log sent: ${type}`);
  } catch (error) {
    console.error('❌ Error sending admin log:', error);
    if (error.code === 'ETELEGRAM' && error.response?.body?.description?.includes('group chat was upgraded')) {
      console.error('⚠️ Admin group was upgraded to supergroup. Please update ADMIN_GROUP_ID.');
      console.error('💡 Use /group_info command to get the new supergroup ID.');
    }
  }
}

async function sendAdminError(error, context = '') {
  try {
    // Check if admin group ID is valid (can be normal group or supergroup)
    if (!ADMIN_GROUP_ID || (!ADMIN_GROUP_ID.startsWith('-') && !ADMIN_GROUP_ID.startsWith('-100'))) {
      console.log(`⚠️ Invalid admin group ID: ${ADMIN_GROUP_ID}. Admin error logs disabled.`);
      return;
    }
    
    const timestamp = new Date().toLocaleString('tr-TR');
    const errorMessage = `🚨 ERROR - ${timestamp}\n\n` +
      `Context: ${context}\n` +
      `Error: ${error.message || error}\n` +
      `Stack: ${error.stack || 'No stack trace'}`;
    
    await sendMessageWithRateLimit(ADMIN_GROUP_ID, errorMessage);
    console.log(`📤 Admin error log sent: ${context}`);
  } catch (err) {
    console.error('❌ Error sending admin error log:', err);
    if (err.code === 'ETELEGRAM' && err.response?.body?.description?.includes('group chat was upgraded')) {
      console.error('⚠️ Admin group was upgraded to supergroup. Please update ADMIN_GROUP_ID.');
    }
  }
}

async function sendAdminStats(stats) {
  try {
    // Check if admin group ID is valid (can be normal group or supergroup)
    if (!ADMIN_GROUP_ID || (!ADMIN_GROUP_ID.startsWith('-') && !ADMIN_GROUP_ID.startsWith('-100'))) {
      console.log(`⚠️ Invalid admin group ID: ${ADMIN_GROUP_ID}. Admin stats disabled.`);
      return;
    }
    
    const timestamp = new Date().toLocaleString('tr-TR');
    const statsMessage = `📈 STATS - ${timestamp}\n\n` +
      `🤖 Bot Status: ✅ Online\n` +
      `📊 Cache Size: ${stats.cacheSize} users\n` +
      `🔒 Processed Messages: ${stats.processedMessages}\n` +
      `📝 Queue Size: ${stats.queueSize}\n` +
      `👥 Active Users: ${stats.activeUsers}\n` +
      `💬 Total Messages: ${stats.totalMessages}\n` +
      `⭐ Total XP Awarded: ${stats.totalXP}`;
    
    await sendMessageWithRateLimit(ADMIN_GROUP_ID, statsMessage);
  } catch (error) {
    console.error('❌ Error sending admin stats:', error);
    if (error.code === 'ETELEGRAM' && error.response?.body?.description?.includes('group chat was upgraded')) {
      console.error('⚠️ Admin group was upgraded to supergroup. Please update ADMIN_GROUP_ID.');
    }
  }
}

async function processMessageQueue() {
  if (isProcessingQueue || messageQueue.length === 0) {
    return;
  }
  
  isProcessingQueue = true;
  
  while (messageQueue.length > 0) {
    const messageData = messageQueue.shift();
    
    try {
      console.log(`📤 Sending message to ${messageData.chatId} (Queue: ${messageQueue.length} remaining)`);
      
      const result = await bot.sendMessage(
        messageData.chatId,
        messageData.message,
        messageData.options
      );
      
      messageData.resolve(result);
      
      // Rate limiting delay
      if (messageQueue.length > 0) {
        await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_DELAY));
      }
      
    } catch (error) {
      console.error('❌ Error sending message:', error);
      messageData.reject(error);
      
      // If rate limited, wait longer
      if (error.code === 429) {
        console.log(`⏳ Rate limited, waiting ${RATE_LIMIT_RETRY_DELAY/1000} seconds...`);
        await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_RETRY_DELAY));
      }
    }
  }
  
  isProcessingQueue = false;
}

async function updateUserActivity(telegramId, updates) {
  try {
    console.log(`🔄 Updating activity for user ${telegramId}:`, updates);
    
    // Validate input data to prevent duplicates
    if (!updates.messageCount || updates.messageCount <= 0) {
      console.log(`⚠️ Invalid message count for user ${telegramId}: ${updates.messageCount}`);
      return;
    }
    
    if (!updates.xpEarned || updates.xpEarned <= 0) {
      console.log(`⚠️ Invalid XP earned for user ${telegramId}: ${updates.xpEarned}`);
      return;
    }
    
    // Get current activity
    const { data: currentActivity, error: fetchError } = await supabase
      .from('telegram_activities')
      .select('*')
      .eq('telegram_id', telegramId)
      .single();
    
    if (fetchError && fetchError.code !== 'PGRST116') {
      throw fetchError;
    }
    
    if (!currentActivity) {
      // Create new activity record
      const newActivity = {
        telegram_id: telegramId,
        message_count: updates.messageCount,
        total_reactions: 0,
        total_xp: updates.xpEarned,
        current_level: 1,
        last_activity: new Date().toISOString()
      };
      
      console.log('📝 Creating new activity record:', newActivity);
      
      await supabase
        .from('telegram_activities')
        .insert([newActivity]);
        
      console.log('✅ New activity record created');
      
      // Check for milestones for new users
      await checkMilestones(telegramId, updates.xpEarned, updates.messageCount);
      
    } else {
      // Update existing activity
      const newTotalXP = currentActivity.total_xp + updates.xpEarned;
      const newMessageCount = currentActivity.message_count + updates.messageCount;
      const newLevel = calculateLevel(newTotalXP);
      const oldLevel = currentActivity.current_level;
      
      const updateData = {
        message_count: newMessageCount,
        total_reactions: 0, // Reactions disabled
        total_xp: newTotalXP,
        current_level: newLevel,
        last_activity: new Date().toISOString()
      };
      
      console.log('📝 Updating activity record:', {
        old: { xp: currentActivity.total_xp, messages: currentActivity.message_count, level: oldLevel },
        new: { xp: newTotalXP, messages: newMessageCount, level: newLevel },
        delta: { xp: updates.xpEarned, messages: updates.messageCount }
      });
      
      await supabase
        .from('telegram_activities')
        .update(updateData)
        .eq('telegram_id', telegramId);
        
      console.log('✅ Activity record updated');
      
      // Check if user leveled up
      if (newLevel > oldLevel) {
        console.log(`🎉 User ${telegramId} leveled up from ${oldLevel} to ${newLevel}!`);
        console.log(`📊 Level up details:`, {
          telegramId,
          oldLevel,
          newLevel,
          oldXP: currentActivity.total_xp,
          newXP: newTotalXP,
          xpGained: updates.xpEarned
        });
        
        // Get user info for notification
        const { data: userInfo, error: userError } = await supabase
          .from('telegram_users')
          .select('username, first_name')
          .eq('telegram_id', telegramId)
          .single();
        
        if (!userError && userInfo) {
          const username = userInfo.username || userInfo.first_name;
          const levelName = getLevelName(newLevel);
          const oldLevelName = getLevelName(oldLevel);
          const newReward = getLevelReward(newLevel);
          
          const levelUpMessage = `🎉 **LEVEL UP!** 🎉\n\n` +
            `Congratulations @${username}! 🏆\n\n` +
            `You've leveled up from **${oldLevelName}** to **${levelName}**!\n` +
            `⭐ Total XP: ${newTotalXP}\n` +
            `💬 Messages: ${newMessageCount}\n\n` +
            `🎁 Daily Reward: ${newReward} BBLP/day`;
          // Add inline button for claiming daily rewards
          const levelUpKeyboard = {
            inline_keyboard: [[
              {
                text: '🎁 Claim Daily Rewards',
                url: 'https://bblip.io/social-connections'
              }
            ]]
          };
          // Send notification to group
          try {
            await sendMessageWithRateLimit(GROUP_ID, levelUpMessage, { reply_markup: levelUpKeyboard });
            console.log(`✅ Level up notification sent to group for user ${telegramId}: ${oldLevelName} → ${levelName}`);
          } catch (error) {
            console.error('❌ Error sending level up notification:', error);
            console.error('Error details:', JSON.stringify(error, null, 2));
          }
        } else {
          console.log(`⚠️ Could not get user info for level up notification: ${userError || 'No user data'}`);
        }
      }
      
      // Check for milestone achievements
      await checkMilestones(telegramId, newTotalXP, newMessageCount);
    }
  } catch (error) {
    console.error('❌ Error updating user activity:', error);
    throw error;
  }
}

function calculateLevel(totalXP) {
  if (totalXP >= 1001) return 5;  // Diamond
  if (totalXP >= 501) return 4;   // Platinum
  if (totalXP >= 251) return 3;   // Gold
  if (totalXP >= 101) return 2;   // Silver
  return 1;                       // Bronze
}

// Get level name by level number (1-5)
function getLevelName(level) {
  const levelNames = ['Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond'];
  return levelNames[level - 1] || 'Unknown';
}

// Get level reward by level number (1-5)
function getLevelReward(level) {
  const levelRewards = [1, 3, 5, 10, 20];
  return levelRewards[level - 1] || 1;
}

// Check for milestone achievements
async function checkMilestones(telegramId, totalXP, messageCount) {
  try {
    // Get user info
    const { data: userInfo, error: userError } = await supabase
      .from('telegram_users')
      .select('username, first_name')
      .eq('telegram_id', telegramId)
      .single();
    
    if (userError || !userInfo) {
      return;
    }
    
    const username = userInfo.username || userInfo.first_name;
    let milestoneMessage = '';
    
    // XP Milestones
    if (totalXP === 100) {
      milestoneMessage = `🎯 **100 XP Milestone!** 🎯\n\n` +
        `Congratulations @${username}! You've reached 100 XP!\n` +
        `⭐ Keep up the great work!`;
    } else if (totalXP === 500) {
      milestoneMessage = `🔥 **500 XP Milestone!** 🔥\n\n` +
        `Amazing @${username}! You've reached 500 XP!\n` +
        `⭐ You're on fire!`;
    } else if (totalXP === 1000) {
      milestoneMessage = `💎 **1000 XP Milestone!** 💎\n\n` +
        `Incredible @${username}! You've reached 1000 XP!\n` +
        `⭐ You're a legend!`;
    }
    
    // Message Count Milestones
    if (messageCount === 50) {
      milestoneMessage = `💬 **50 Messages Milestone!** 💬\n\n` +
        `Great job @${username}! You've sent 50 messages!\n` +
        `⭐ Keep the conversation going!`;
    } else if (messageCount === 100) {
      milestoneMessage = `📢 **100 Messages Milestone!** 📢\n\n` +
        `Fantastic @${username}! You've sent 100 messages!\n` +
        `⭐ You're a chat champion!`;
    } else if (messageCount === 500) {
      milestoneMessage = `🗣️ **500 Messages Milestone!** 🗣️\n\n` +
        `Unbelievable @${username}! You've sent 500 messages!\n` +
        `⭐ You're the voice of the community!`;
    }
    
    // Send milestone notification if any
    if (milestoneMessage) {
      try {
        await sendMessageWithRateLimit(GROUP_ID, milestoneMessage);
        console.log(`✅ Milestone notification sent for user ${telegramId}`);
      } catch (error) {
        console.error('❌ Error sending milestone notification:', error);
      }
    }
    
  } catch (error) {
    console.error('❌ Error checking milestones:', error);
  }
}

// Daily XP calculation job (run every day at midnight)
async function calculateDailyXP() {
  try {
    console.log('Starting daily XP calculation...');
    
    // Get all connected users
    const { data: users, error } = await supabase
      .from('telegram_users')
      .select('telegram_id')
      .eq('is_active', true);
    
    if (error) {
      console.error('Error fetching users:', error);
      return;
    }
    
    for (const user of users) {
      try {
        // Check if user was active today
        const today = new Date().toISOString().split('T')[0];
        const { data: todayMessages, error: messageError } = await supabase
          .from('telegram_messages')
          .select('id')
          .eq('telegram_id', user.telegram_id)
          .gte('created_at', today)
          .limit(1);
        
        if (messageError) {
          console.error('Error checking today messages:', messageError);
          continue;
        }
        
        if (todayMessages.length > 0) {
          // User was active today, give daily bonus
          await updateUserActivity(user.telegram_id, {
            xpEarned: XP_REWARDS.DAILY_ACTIVE
          });
          
          console.log(`Daily bonus given to user ${user.telegram_id}`);
        }
      } catch (error) {
        console.error(`Error processing user ${user.telegram_id}:`, error);
      }
    }
    
    console.log('Daily XP calculation completed');
  } catch (error) {
    console.error('Error in daily XP calculation:', error);
  }
}

// Schedule daily XP calculation (every 24 hours)
setInterval(calculateDailyXP, 24 * 60 * 60 * 1000);

// Batch processing is now handled by the optimized batchProcessor
// No need for manual setInterval - it's managed by the optimization module

// Error handling
bot.on('error', (error) => {
  console.error('Bot error:', error);
});

bot.on('polling_error', (error) => {
  console.error('Polling error:', error);
});

// Clear cache on startup to prevent duplicates from previous sessions
messageCache.clear();
processedMessages.clear();
messageQueue.length = 0;
isProcessingQueue = false;
userMessageHistory.clear();
spamDetections.clear();
console.log('🧹 Cache, queue, and anti-bot data cleared on startup');

console.log('🤖 Telegram bot started...');
console.log('📊 Bot Info:');
console.log('  - Bot Token:', BOT_TOKEN ? '✅ Set' : '❌ Missing');
console.log('  - Group ID:', GROUP_ID);
console.log('  - Supabase URL:', SUPABASE_URL ? '✅ Set' : '❌ Missing');
console.log('  - Web App URL:', WEB_APP_URL);
console.log('⚡ Rate Limiting:');
console.log(`  - Message Delay: ${RATE_LIMIT_DELAY}ms`);
console.log(`  - Retry Delay: ${RATE_LIMIT_RETRY_DELAY}ms`);
console.log('🛡️ Anti-Bot Protection (Rose Bot Style):');
console.log(`  - Min Message Interval: ${ANTI_BOT_CONFIG.MIN_MESSAGE_INTERVAL}ms`);
console.log(`  - Max Messages/Minute: ${ANTI_BOT_CONFIG.MAX_MESSAGES_PER_MINUTE}`);
console.log(`  - Max Messages/Hour: ${ANTI_BOT_CONFIG.MAX_MESSAGES_PER_HOUR}`);
console.log(`  - Warning Threshold: ${ANTI_BOT_CONFIG.WARNING_THRESHOLD}`);
console.log(`  - Restrict Duration: ${ANTI_BOT_CONFIG.RESTRICT_DURATION}s`);
console.log(`  - Ban Duration: ${ANTI_BOT_CONFIG.BAN_DURATION}s`);
console.log(`  - Use Telegram Restrictions: ${ANTI_BOT_CONFIG.USE_TELEGRAM_RESTRICTIONS}`);
console.log(`  - Auto Unrestrict: ${ANTI_BOT_CONFIG.AUTO_UNRESTRICT}`);
console.log('📡 Polling Settings:');
console.log(`  - Polling Interval: ${POLLING_INTERVAL}ms`);
console.log(`  - Polling Timeout: 5s (via params)`);
console.log(`  - Polling Limit: ${POLLING_LIMIT} updates`);
console.log(`  - Allowed Updates: message, new_chat_members`);
console.log('🔄 Batch Processing:');
console.log(`  - Batch Interval: ${BATCH_INTERVAL / 1000} seconds`);
console.log('🎉 Level Up System:');
console.log('  - Real-time level detection: Instant');
console.log('  - Batch processing: Every 60 seconds');
console.log('  - Level names: Bronze, Silver, Gold, Platinum, Diamond');
console.log('  - Level rewards: 1, 3, 5, 10, 20 BBLP/day');


// Test bot commands function
async function testBotCommands() {
  try {
    const commands = await bot.getMyCommands();
    console.log('📋 Current bot commands:');
    commands.forEach(cmd => {
      console.log(`  - /${cmd.command}: ${cmd.description}`);
    });
  } catch (error) {
    console.error('❌ Error getting bot commands:', error);
  }
}

// Test level up system
async function testLevelUpSystem() {
  try {
    console.log('🧪 Testing level up system...');
    
    // Test level calculations
    const testLevels = [50, 100, 150, 300, 600, 1200];
    testLevels.forEach(xp => {
      const level = calculateLevel(xp);
      const levelName = getLevelName(level);
      const reward = getLevelReward(level);
      console.log(`  - ${xp} XP → Level ${level} (${levelName}) → ${reward} BBLP/day`);
    });
    
    console.log('✅ Level up system test completed');
  } catch (error) {
    console.error('❌ Error testing level up system:', error);
  }
}

// Test admin group connection
async function testAdminGroup() {
  try {
    console.log('🧪 Testing admin group connection...');
    
    if (!ADMIN_GROUP_ID || (!ADMIN_GROUP_ID.startsWith('-') && !ADMIN_GROUP_ID.startsWith('-100'))) {
      console.log(`⚠️ Admin group ID not configured: ${ADMIN_GROUP_ID}`);
      return;
    }
    
    // Try to get chat info to verify the group exists
    const chatInfo = await bot.getChat(ADMIN_GROUP_ID);
    console.log(`✅ Admin group verified: ${chatInfo.title} (${chatInfo.type})`);
    
    // Try to send a test message
    await sendAdminLog('🧪 Admin group connection test - Success!', 'TEST');
    console.log('✅ Admin group test message sent');
    
  } catch (error) {
    console.error('❌ Admin group test failed:', error.message);
    if (error.code === 'ETELEGRAM' && error.response?.body?.description?.includes('group chat was upgraded')) {
      console.error('💡 Group was upgraded to supergroup. Use /group_info to get new ID.');
    }
  }
}

// Set bot commands for Telegram menu
async function setBotCommands() {
  try {
    // Default commands (English)
    const defaultCommands = [
      { command: 'start', description: '🚀 Connect your account to start earning XP' },
      { command: 'my_xp', description: '📊 View your XP stats and current level' },
      { command: 'my_referral', description: '🔗 Get your referral link and earn rewards' },
      { command: 'leaderboard', description: '🏆 View top 10 users by XP' },
      { command: 'help', description: '❓ Show all available commands' },
      { command: 'ban', description: '🚫 Ban a user (Admin only)' },
      { command: 'unban', description: '🔓 Unban a user (Admin only)' },
      { command: 'debug_level', description: '🔍 Debug level up system (Admin only)' },
      { command: 'admin_stats', description: '📊 View bot statistics (Admin only)' },
      { command: 'admin_test', description: '🧪 Test admin group connection (Admin only)' },
      { command: 'group_info', description: '📊 Get group information (Admin only)' },
      { command: 'test_welcome', description: '🧪 Test welcome message system (Admin only)' },
      { command: 'auto_delete', description: '🗑️ Configure auto-delete settings (Admin only)' }
    ];
    
    // Turkish commands
    const turkishCommands = [
      { command: 'start', description: '🚀 Hesabınızı bağlayın ve XP kazanmaya başlayın' },
      { command: 'my_xp', description: '📊 XP istatistiklerinizi ve seviyenizi görün' },
      { command: 'leaderboard', description: '🏆 En iyi 10 kullanıcıyı XP\'ye göre görün' },
      { command: 'help', description: '❓ Tüm komutları göster' },
      { command: 'ban', description: '🚫 Kullanıcıyı yasakla (Sadece Admin)' },
      { command: 'unban', description: '🔓 Kullanıcının yasağını kaldır (Sadece Admin)' },
      { command: 'debug_level', description: '🔍 Seviye yükselme sistemini debug et (Sadece Admin)' },
      { command: 'admin_stats', description: '📊 Bot istatistiklerini görün (Sadece Admin)' },
      { command: 'admin_test', description: '🧪 Admin grup bağlantısını test et (Sadece Admin)' },
      { command: 'group_info', description: '📊 Grup bilgilerini al (Sadece Admin)' },
      { command: 'test_welcome', description: '🧪 Welcome mesaj sistemini test et (Sadece Admin)' },
      { command: 'auto_delete', description: '🗑️ Auto-delete ayarlarını yapılandır (Sadece Admin)' }
    ];
    
    // User commands for private (default) scope
    const privateUserCommands = [
      { command: 'start', description: '🚀 Connect your account to start earning XP' },
      { command: 'my_xp', description: '📊 View your XP stats and current level' },
      { command: 'my_referral', description: '🔗 Get your referral link and earn rewards' },
      { command: 'leaderboard', description: '🏆 View top 10 users by XP' },
      { command: 'help', description: '❓ Show all available commands' }
    ];
    // User commands for group scopes (no /start)
    const groupUserCommands = [
      { command: 'my_xp', description: '📊 View your XP stats and current level' },
      { command: 'my_referral', description: '🔗 Get your referral link and earn rewards' },
      { command: 'leaderboard', description: '🏆 View top 10 users by XP' },
      { command: 'help', description: '❓ Show all available commands' }
    ];
    // Turkish user commands for private (default) scope
    const turkishPrivateUserCommands = [
      { command: 'start', description: '🚀 Hesabınızı bağlayın ve XP kazanmaya başlayın' },
      { command: 'my_xp', description: '📊 XP istatistiklerinizi ve seviyenizi görün' },
      { command: 'leaderboard', description: '🏆 En iyi 10 kullanıcıyı XP\'ye göre görün' },
      { command: 'help', description: '❓ Tüm komutları göster' }
    ];
    // Turkish user commands for group scopes (no /start)
    const turkishGroupUserCommands = [
      { command: 'my_xp', description: '📊 XP istatistiklerinizi ve seviyenizi görün' },
      { command: 'leaderboard', description: '🏆 En iyi 10 kullanıcıyı XP\'ye göre görün' },
      { command: 'help', description: '❓ Tüm komutları göster' }
    ];
    
    // Admin commands (English)
    const adminCommands = [
      { command: 'ban', description: '🚫 Ban a user (Admin only)' },
      { command: 'unban', description: '🔓 Unban a user (Admin only)' },
      { command: 'debug_level', description: '🔍 Debug level up system (Admin only)' },
      { command: 'admin_stats', description: '📊 View bot statistics (Admin only)' },
      { command: 'admin_test', description: '🧪 Test admin group connection (Admin only)' },
      { command: 'group_info', description: '📊 Get group information (Admin only)' },
      { command: 'test_welcome', description: '🧪 Test welcome message system (Admin only)' },
      { command: 'auto_delete', description: '🗑️ Configure auto-delete settings (Admin only)' }
    ];
    
    // Turkish admin commands
    const turkishAdminCommands = [
      { command: 'ban', description: '🚫 Kullanıcıyı yasakla (Sadece Admin)' },
      { command: 'unban', description: '🔓 Kullanıcının yasağını kaldır (Sadece Admin)' },
      { command: 'debug_level', description: '🔍 Seviye yükselme sistemini debug et (Sadece Admin)' },
      { command: 'admin_stats', description: '📊 Bot istatistiklerini görün (Sadece Admin)' },
      { command: 'admin_test', description: '🧪 Admin grup bağlantısını test et (Sadece Admin)' },
      { command: 'group_info', description: '📊 Grup bilgilerini al (Sadece Admin)' },
      { command: 'test_welcome', description: '🧪 Welcome mesaj sistemini test et (Sadece Admin)' },
      { command: 'auto_delete', description: '🗑️ Auto-delete ayarlarını yapılandır (Sadece Admin)' }
    ];
    // Set private (default) commands
    await bot.setMyCommands(privateUserCommands);
    await bot.setMyCommands(turkishPrivateUserCommands, { scope: { type: 'all_private_chats' }, language_code: 'tr' });
    // Set group commands (no /start)
    await bot.setMyCommands(groupUserCommands, { scope: { type: 'chat', chat_id: GROUP_ID } });
    await bot.setMyCommands([...groupUserCommands, ...adminCommands], { scope: { type: 'chat_administrators', chat_id: GROUP_ID } });
    await bot.setMyCommands(turkishGroupUserCommands, { scope: { type: 'chat', chat_id: GROUP_ID }, language_code: 'tr' });
    await bot.setMyCommands([...turkishGroupUserCommands, ...turkishAdminCommands], { scope: { type: 'chat_administrators', chat_id: GROUP_ID }, language_code: 'tr' });
    
    // Set default commands
    await bot.setMyCommands(defaultCommands);
    console.log('✅ Default bot commands set successfully');
    
    // Set Turkish commands
    await bot.setMyCommands(turkishCommands, { scope: { type: 'all_private_chats' }, language_code: 'tr' });
    console.log('✅ Turkish bot commands set successfully');
    
    // Set commands for specific group
    await bot.setMyCommands(defaultCommands, { scope: { type: 'chat', chat_id: GROUP_ID } });
    console.log(`✅ Bot commands set for group ${GROUP_ID}`);
    
    // Set Turkish commands for group
    await bot.setMyCommands(turkishCommands, { scope: { type: 'chat', chat_id: GROUP_ID }, language_code: 'tr' });
    console.log(`✅ Turkish bot commands set for group ${GROUP_ID}`);
    
  } catch (error) {
    console.error('❌ Error setting bot commands:', error);
  }
}

// Start bot with optimized polling
bot.startPolling().then(async () => {
  console.log('✅ Bot polling started successfully');
  
  // Set bot commands after polling starts
  await setBotCommands();
  
  // Send startup notification to admin group
  if (ADMIN_GROUP_ID && (ADMIN_GROUP_ID.startsWith('-') || ADMIN_GROUP_ID.startsWith('-100'))) {
    try {
      await sendAdminLog(
        `🚀 Bot Started Successfully\n\n` +
        `🤖 Bot Token: ${BOT_TOKEN ? '✅ Set' : '❌ Missing'}\n` +
        `📊 Supabase: ${SUPABASE_URL ? '✅ Connected' : '❌ Error'}\n` +
        `👥 Main Group: ${GROUP_ID}\n` +
        `🔧 Admin Group: ${ADMIN_GROUP_ID}\n` +
        `🌐 Web App: ${WEB_APP_URL}\n\n` +
        `⚡ Real-time level detection: Enabled\n` +
        `🔄 Batch processing: Every 60 seconds\n` +
        `🛡️ Anti-bot protection: Active\n` +
        `📡 Polling: ${POLLING_INTERVAL}ms interval, 5s timeout\n` +
        `👋 Welcome messages: Enabled (new_chat_members events)\n` +
        `🗑️ Auto-delete: ${WELCOME_MESSAGE_DELETE_ENABLED ? 'Enabled' : 'Disabled'} (${WELCOME_MESSAGE_DELETE_DELAY/1000}s)\n` +
        `📱 Private connection messages: Enabled\n` +
        `🔗 Referral system: ${REFERRAL_SYSTEM_ENABLED ? 'Enabled' : 'Disabled'} (+${REFERRAL_XP_REWARD} XP, +${REFERRAL_BBLP_REWARD} BBLP) - Bot first, then group`,
        'STARTUP'
      );
      console.log(`✅ Admin startup notification sent to group ${ADMIN_GROUP_ID}`);
    } catch (error) {
      console.log(`⚠️ Could not send admin startup notification: ${error.message}`);
      console.log(`📝 Admin logs may be disabled. Use /admin_test to check.`);
    }
  } else {
    console.log(`⚠️ Admin group ID not configured or invalid: ${ADMIN_GROUP_ID}`);
    console.log(`📝 Admin logs will be disabled. Set TELEGRAM_ADMIN_GROUP_ID to enable.`);
  }
  
  // Test bot commands and level up system
  setTimeout(async () => {
    await testBotCommands();
    await testLevelUpSystem();
    await testAdminGroup();
  }, 2000); // Wait 2 seconds for commands to be set
  
}).catch((error) => {
  console.error('❌ Error starting bot polling:', error);
  sendAdminError(error, 'Bot startup');
});

console.log('🔍 Waiting for messages and member joins...');
console.log('📋 Bot Commands:');
console.log('  - /start - Connect account');
console.log('  - /my_xp - View XP stats');
console.log('  - /leaderboard - View top users');
console.log('  - /help - Show all commands');
console.log('  - /ban - Ban user (Admin)');
console.log('  - /unban - Unban user (Admin)');
console.log('  - /debug_level - Debug level system (Admin)');
console.log('  - /admin_stats - View bot statistics (Admin)');
console.log('  - /admin_test - Test admin group (Admin)');
console.log('  - /group_info - Get group information (Admin)');
console.log('  - /admin_log <message> - Send log to admin group (Admin)');
console.log('  - /test_welcome - Test welcome message system (Admin)');
console.log('👋 Auto Welcome: Enabled for new/returning members');
console.log(`🗑️ Auto-delete: ${WELCOME_MESSAGE_DELETE_ENABLED ? 'Enabled' : 'Disabled'} (${WELCOME_MESSAGE_DELETE_DELAY/1000}s)`);
console.log('📱 Private connection messages: Enabled for unconnected users');
console.log(`🔗 Referral system: ${REFERRAL_SYSTEM_ENABLED ? 'Enabled' : 'Disabled'} (+${REFERRAL_XP_REWARD} XP, +${REFERRAL_BBLP_REWARD} BBLP per referral) - Bot first, then group`);

// Yeni anti-spam ve XP kontrolü
global.userSpamData = global.userSpamData || new Map(); // telegramId -> { lastMessage: '', warnings: 0, messageTimestamps: [] }

async function handleAntiSpamAndXP(msg) {
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  const now = Date.now();
  let spamData = global.userSpamData.get(userId) || { lastMessage: '', warnings: 0, messageTimestamps: [] };
  // 1 dakikalık mesaj zaman damgalarını güncelle
  spamData.messageTimestamps = spamData.messageTimestamps.filter(ts => now - ts < 60000);
  spamData.messageTimestamps.push(now);

  // Spam limiti kontrolü
  if (spamData.messageTimestamps.length > 10) {
    spamData.warnings++;
    let timeoutDuration = 5 * 60; // 5 dakika (saniye)
    if (spamData.warnings === 2) timeoutDuration = 30 * 60; // 30 dakika
    if (spamData.warnings >= 3) timeoutDuration = 24 * 60 * 60; // 24 saat
    try {
      await bot.restrictChatMember(chatId, userId, { until_date: Math.floor(Date.now()/1000) + timeoutDuration });
      await bot.sendMessage(chatId, `⚠️ <a href="tg://user?id=${userId}">Kullanıcı</a> spam nedeniyle ${Math.floor(timeoutDuration/60)} dakika susturuldu. (Uyarı: ${spamData.warnings})`, { parse_mode: 'HTML' });
    } catch (error) { console.error('Timeout error:', error); }
    global.userSpamData.set(userId, spamData);
    return false;
  }

  // Aynı mesajı tekrar atma kontrolü
  if (msg.text === spamData.lastMessage) {
    await bot.sendMessage(chatId, `⚠️ Aynı mesajı tekrar atıyorsun, XP kazanamazsın!`, { reply_to_message_id: msg.message_id });
    spamData.lastMessage = msg.text;
    global.userSpamData.set(userId, spamData);
    return false;
  }

  // 10 karakterden kısa mesajlara XP verme
  if (!msg.text || msg.text.length < 10) {
    global.userSpamData.set(userId, spamData);
    return false;
  }

  // XP ver ve son mesajı güncelle
  spamData.lastMessage = msg.text;
  global.userSpamData.set(userId, spamData);
  return true;
}

module.exports = bot; 