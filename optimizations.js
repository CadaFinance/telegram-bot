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
  
  add(update) {
    this.queue.push(update);
    console.log('[BatchProcessor] Update added to queue. Queue length:', this.queue.length, 'Update:', update);
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
      // Her kullanıcı için mevcut total_xp'yi çekip cache ile topla
      for (const update of batch) {
        const { telegramId, data } = update;
        const { data: activity, error } = await supabase
          .from('telegram_activities')
          .select('total_xp')
          .eq('telegram_id', telegramId)
          .single();
        let currentTotalXP = 0;
        if (!error && activity && typeof activity.total_xp === 'number') {
          currentTotalXP = activity.total_xp;
        }
        update.data.totalXP = currentTotalXP + data.xpEarned;
      }
      await this.executeBatch(batch);
      metrics.batchUpdates++;
      console.log('[BatchProcessor] Batch processed successfully.');
    } catch (error) {
      console.error('[BatchProcessor] Batch processing error:', error);
      metrics.errors++;
    } finally {
      this.processing = false;
    }
  }
  
  async executeBatch(batch) {
    console.log('[BatchProcessor] Executing batch upsert. Updates:', JSON.stringify(batch));
    const updates = batch.map(({ telegramId, data }) => ({
      telegram_id: telegramId,
      message_count: data.messageCount,
      total_xp: data.totalXP, // cache + db toplamı
      updated_at: new Date().toISOString()
    }));
    
    return await dbCircuitBreaker.execute(async () => {
      const { error } = await supabase
        .from('telegram_activities')
        .upsert(updates, { 
          onConflict: 'telegram_id',
          ignoreDuplicates: false 
        });
      
      if (error) {
        console.error('[BatchProcessor] Upsert error:', error);
        throw error;
      }
      console.log('[BatchProcessor] Upsert successful. Row count:', updates.length);
      return { processed: updates.length };
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
    // Check rate limiting
    if (!rateLimiter.isAllowed(userId)) {
      console.log(`⚠️ Rate limited user: ${userId}`);
      return;
    }
    
    // Check if message already processed
    if (processedMessages.has(messageKey)) {
      metrics.cacheHits++;
      return;
    }
    
    // Add to processed messages
    processedMessages.set(messageKey, true);
    
    // Get cached user data
    let cachedData = messageCache.get(userId);
    if (!cachedData) {
      cachedData = {
        messageCount: 0,
        xpEarned: 0,
        processedMessages: new Set(),
        lastUpdate: Date.now()
      };
      messageCache.set(userId, cachedData);
      metrics.cacheMisses++;
    } else {
      metrics.cacheHits++;
    }
    
    // Update cached data
    cachedData.messageCount++;
    cachedData.xpEarned += 1; // 1 XP per message
    cachedData.processedMessages.set(messageKey, true);
    cachedData.lastUpdate = Date.now();
    
    // Add to batch processor
    batchProcessor.add({
      telegramId: userId,
      data: {
        messageCount: cachedData.messageCount,
        xpEarned: cachedData.xpEarned
      }
    });
    
    // Update metrics
    const duration = Date.now() - startTime;
    metrics.messagesProcessed++;
    metrics.avgResponseTime = (metrics.avgResponseTime + duration) / 2;
    
  } catch (error) {
    console.error('❌ Error in optimized message processing:', error);
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