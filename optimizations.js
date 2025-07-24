// Telegram Bot Optimizations
// Critical performance improvements

const { LRUCache } = require('lru-cache');

// Supabase client reference (will be set by bot.js)
let supabase;
function setSupabaseClient(supabaseClient) {
  supabase = supabaseClient;
}

module.exports.setSupabaseClient = setSupabaseClient; 

// Optimized polling configuration
const OPTIMIZED_POLLING_CONFIG = {
  interval: 500, // 500ms polling interval
  limit: 50 // 50 updates per poll
};

// 1. OPTIMIZED CACHE SYSTEM
const messageCache = new LRUCache({
  max: 1000, // Max 1000 users
  maxAge: 1000 * 60 * 10, // 10 minutes
  updateAgeOnGet: true,
  dispose: (key, value) => {
    console.log(`🗑️ Cache entry expired: ${key}`);
  }
});

const processedMessages = new LRUCache({
  max: 5000, // Max 5000 messages
  maxAge: 1000 * 60 * 5, // 5 minutes
  updateAgeOnGet: true
});

// 2. PERFORMANCE METRICS
const metrics = {
  messagesProcessed: 0,
  dbQueries: 0,
  cacheHits: 0,
  cacheMisses: 0,
  avgResponseTime: 0,
  errors: 0,
  batchUpdates: 0,
  memoryUsage: 0
};

// 3. CIRCUIT BREAKER FOR DATABASE
class CircuitBreaker {
  constructor(failureThreshold = 5, timeout = 60000) {
    this.failureThreshold = failureThreshold;
    this.timeout = timeout;
    this.failures = 0;
    this.lastFailureTime = null;
    this.state = 'CLOSED';
  }
  
  async execute(fn) {
    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailureTime > this.timeout) {
        this.state = 'HALF_OPEN';
      } else {
        throw new Error('Circuit breaker is OPEN');
      }
    }
    
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }
  
  onSuccess() {
    this.failures = 0;
    this.state = 'CLOSED';
  }
  
  onFailure() {
    this.failures++;
    this.lastFailureTime = Date.now();
    
    if (this.failures >= this.failureThreshold) {
      this.state = 'OPEN';
      console.warn('⚠️ Circuit breaker opened due to failures');
    }
  }
}

const dbCircuitBreaker = new CircuitBreaker();

// 4. BATCH PROCESSING OPTIMIZATION
class BatchProcessor {
  constructor(batchSize = 50, batchInterval = 30000) {
    this.batchSize = batchSize;
    this.batchInterval = batchInterval;
    this.queue = [];
    this.processing = false;
    this.interval = null;
  }
  
  calculateLevel(totalXP) {
    if (totalXP < 251) return 1; // Bronze
    if (totalXP < 501) return 2; // Silver
    if (totalXP < 1001) return 3; // Gold
    if (totalXP < 2001) return 4; // Platinum
    return 5; // Diamond
  }
  
  start() {
    console.log('[BatchProcessor] Starting batch interval:', this.batchInterval, 'ms');
    this.interval = setInterval(() => {
      console.log('[BatchProcessor] Batch interval triggered. Queue length:', this.queue.length);
      this.processBatch();
    }, this.batchInterval);
  }
  
  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      console.log('[BatchProcessor] Batch interval stopped.');
    }
  }
  
  add(telegramId, xpAmount, reason = 'activity') {
    console.log(`[BatchProcessor] add() called with: ${telegramId}, ${xpAmount} XP, ${reason}`);
    
    // Check if user already has pending updates
    const existingIndex = this.queue.findIndex(item => item.telegramId === telegramId);
    
    if (existingIndex !== -1) {
      // Merge with existing update
      const existing = this.queue[existingIndex];
      existing.data.xpEarned += xpAmount;
      existing.data.messageCount += 1;
      console.log(`[BatchProcessor] Merged update for user ${telegramId}. Total: ${existing.data.xpEarned} XP`);
    } else {
      // Add new update
      this.queue.push({
        telegramId: telegramId,
        data: {
          messageCount: 1,
          xpEarned: xpAmount
        }
      });
      console.log(`[BatchProcessor] New update added for user ${telegramId}: ${xpAmount} XP`);
    }
    
    console.log('[BatchProcessor] Queue length:', this.queue.length);
    
    if (this.queue.length >= this.batchSize) {
      console.log('[BatchProcessor] Queue reached batch size. Triggering processBatch.');
      this.processBatch();
    }
  }
  
  async processBatch() {
    if (this.processing) {
      console.log('[BatchProcessor] Already processing. Skipping.');
      return;
    }
    if (this.queue.length === 0) {
      console.log('[BatchProcessor] Queue empty. Nothing to process.');
      return;
    }
    this.processing = true;
    const batch = this.queue.splice(0, this.batchSize);
    console.log('[BatchProcessor] Processing batch. Batch size:', batch.length, 'Batch:', JSON.stringify(batch));
    try {
      // Process each user's XP update (Discord bot style - no user connection check)
      const batchUpdates = [];
      
      for (const update of batch) {
        const { telegramId, data } = update;
        
        try {
          // Get current activity from database (no connection check)
          const { data: activity, error } = await dbCircuitBreaker.execute(async () => {
            return await supabase
              .from('telegram_activities')
              .select('total_xp, current_level, message_count')
              .eq('telegram_id', telegramId)
              .single();
          });
          
          let currentTotalXP = 0;
          let currentLevel = 1;
          let currentMessageCount = 0;
          
          if (!error && activity) {
            currentTotalXP = activity.total_xp || 0;
            currentLevel = activity.current_level || 1;
            currentMessageCount = activity.message_count || 0;
          }
          
          // Calculate new XP and level
          const newTotalXP = currentTotalXP + data.xpEarned;
          const newMessageCount = currentMessageCount + data.messageCount;
          const newLevel = this.calculateLevel(newTotalXP);
          
          batchUpdates.push({
            telegram_id: telegramId,
            message_count: newMessageCount,
            total_xp: newTotalXP,
            current_level: newLevel,
            last_activity: new Date().toISOString()
          });
          
          console.log(`📊 User ${telegramId}: ${currentTotalXP} + ${data.xpEarned} = ${newTotalXP} XP (Level ${newLevel}), Messages: ${currentMessageCount} + ${data.messageCount} = ${newMessageCount}`);
          
        } catch (error) {
          console.error(`❌ Error processing XP update for ${telegramId}:`, error);
        }
      }
      
      if (batchUpdates.length > 0) {
        await this.executeBatch(batchUpdates);
        metrics.batchUpdates++;
        console.log('[BatchProcessor] Batch processed successfully.');
      } else {
        console.log('[BatchProcessor] No valid updates to process.');
      }
    } catch (error) {
      console.error('[BatchProcessor] Batch processing error:', error);
      metrics.errors++;
    } finally {
      this.processing = false;
    }
  }
  
  async executeBatch(batchUpdates) {
    console.log('[BatchProcessor] Executing batch upsert. Updates:', JSON.stringify(batchUpdates));
    
    return await dbCircuitBreaker.execute(async () => {
      const { error } = await supabase
        .from('telegram_activities')
        .upsert(batchUpdates, { 
          onConflict: 'telegram_id',
          ignoreDuplicates: false 
        });
      
      if (error) {
        console.error('[BatchProcessor] Upsert error:', error);
        throw error;
      }
      console.log('[BatchProcessor] Upsert successful. Row count:', batchUpdates.length);
      
      // Update cache for these users (don't reset, just update with new totals)
      batchUpdates.forEach(update => {
        const cachedData = messageCache.get(update.telegram_id);
        if (cachedData) {
          // Update cache with new totals and reset pending amounts
          cachedData.totalXP = update.total_xp;
          cachedData.messageCount = update.message_count;
          cachedData.xpEarned = 0; // Reset pending XP
          cachedData.pendingMessages = 0; // Reset pending messages
          console.log(`🔄 Updated cache for user ${update.telegram_id}: ${update.total_xp} XP, ${update.message_count} messages`);
        }
      });
      
      return { processed: batchUpdates.length };
    });
  }
}

const batchProcessor = new BatchProcessor();

// 5. MEMORY MONITORING
function startMemoryMonitoring() {
  setInterval(() => {
    const memUsage = process.memoryUsage();
    metrics.memoryUsage = Math.round(memUsage.heapUsed / 1024 / 1024);
    
    console.log('💾 Memory Usage:', {
      rss: Math.round(memUsage.rss / 1024 / 1024) + ' MB',
      heapUsed: metrics.memoryUsage + ' MB',
      heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024) + ' MB',
      cacheSize: messageCache.size
    });
    
    if (memUsage.heapUsed > 500 * 1024 * 1024) { // 500MB
      console.warn('⚠️ High memory usage detected');
      messageCache.clear();
      processedMessages.clear();
      global.gc && global.gc(); // Force garbage collection
    }
  }, 60000); // Every minute
}

// 6. OPTIMIZED POLLING CONFIGURATION
// (Already defined at the top of the file)

// 7. RATE LIMITING OPTIMIZATION
class RateLimiter {
  constructor(maxRequests = 10, windowMs = 60000) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    this.requests = new Map();
  }
  
  isAllowed(userId) {
    const now = Date.now();
    const userRequests = this.requests.get(userId) || [];
    
    // Remove old requests
    const validRequests = userRequests.filter(time => now - time < this.windowMs);
    
    if (validRequests.length >= this.maxRequests) {
      return false;
    }
    
    validRequests.push(now);
    this.requests.set(userId, validRequests);
    return true;
  }
  
  cleanup() {
    const now = Date.now();
    for (const [userId, requests] of this.requests.entries()) {
      const validRequests = requests.filter(time => now - time < this.windowMs);
      if (validRequests.length === 0) {
        this.requests.delete(userId);
      } else {
        this.requests.set(userId, validRequests);
      }
    }
  }
}

const rateLimiter = new RateLimiter();

// 8. HEALTH CHECK ENDPOINT
// (Removed to simplify the bot)

// 9. OPTIMIZED MESSAGE PROCESSING
async function processMessageOptimized(msg, messageKey, userId, messageText, userDisplayName) {
  const startTime = Date.now();
  
  try {
    console.log(`🚀 processMessageOptimized called for user ${userId} (@${userDisplayName})`);
    
    // Check rate limiting
    if (!rateLimiter.isAllowed(userId)) {
      console.log(`⚠️ Rate limited user: ${userId}`);
      return;
    }
    
    // Message is already marked as processed in main bot file
    // Just add to processed messages for metrics
    processedMessages.set(messageKey, true);
    
    // Add XP for message (Discord bot style - no user connection check)
    console.log(`🎯 Adding XP for user ${userId} (@${userDisplayName}): +1 XP (message)`);
    
    // Add to batch processor
    console.log(`📦 Adding to batch processor: ${userId} -> +1 XP`);
    batchProcessor.add(userId, 1, 'message');
    console.log(`✅ Added to batch processor. Queue length: ${batchProcessor.queue.length}`);
    
    // Update metrics
    const duration = Date.now() - startTime;
    metrics.messagesProcessed++;
    metrics.avgResponseTime = (metrics.avgResponseTime + duration) / 2;
    
    console.log(`✅ XP added successfully for ${userId} (@${userDisplayName}) in ${duration}ms`);
    
  } catch (error) {
    console.error('❌ Error in optimized message processing:', error);
    console.error('❌ Error stack:', error.stack);
    metrics.errors++;
  }
}

// 10. CLEANUP FUNCTIONS
function cleanup() {
  console.log('🧹 Starting cleanup...');
  
  // Clear caches
  messageCache.clear();
  processedMessages.clear();
  
  // Stop batch processor
  batchProcessor.stop();
  
  // Cleanup rate limiter
  rateLimiter.cleanup();
  
  console.log('✅ Cleanup completed');
}

// 11. INITIALIZATION
function initializeOptimizations() {
  console.log('🚀 Initializing optimizations...');
  
  // Start batch processor
  batchProcessor.start();
  
  // Start memory monitoring
  startMemoryMonitoring();
  
  // Cleanup on process exit
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  
  console.log('✅ Optimizations initialized');
}

module.exports = {
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
}; 