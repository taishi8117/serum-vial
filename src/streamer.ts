import { RedisClientType } from '@node-redis/client'
import { createClient } from 'redis'
import { isMainThread, threadId, workerData } from 'worker_threads'
import { cleanupChannel, serumDataChannel } from './helpers'
import { logger } from './logger'
import { MessageEnvelope } from './serum_producer'

const meta = {
  minionId: threadId
}

if (isMainThread) {
  const message = 'Exiting. Worker is not meant to run in main thread'
  logger.log('error', message, meta)

  throw new Error(message)
}

class LRUCache<T> {
  private values: Map<string, T> = new Map<string, T>()
  private maxEntries: number

  constructor(maxEntries: number) {
    this.maxEntries = maxEntries
  }

  public has(key: string): boolean {
    return this.values.has(key)
  }

  public get(key: string): T | undefined {
    const hasKey = this.values.has(key)
    if (hasKey) {
      let entry: T
      entry = this.values.get(key)!
      this.values.delete(key)
      this.values.set(key, entry)
      return entry
    } else {
      return undefined
    }
  }

  public put(key: string, value: T) {
    if (this.values.size >= this.maxEntries) {
      // delete least recently used
      const keyToDelete = this.values.keys().next().value
      this.values.delete(keyToDelete)
    }
    this.values.set(key, value)
  }
}

class Streamer {
  private _heartbeatTimer: NodeJS.Timeout | undefined = undefined

  private _redisCli: RedisClientType
  private _redisKeyPrefix: string
  private _commitment: string
  private _cache: LRUCache<any>
  private _messages_sent: number = 0

  constructor(_redisUrl: string, _redisKeyPrefix: string, commitment: string) {
    this._redisCli = createClient({
      url: _redisUrl
    })
    this._redisKeyPrefix = _redisKeyPrefix
    this._commitment = commitment
    this._cache = new LRUCache(1000)
  }

  private getTradeKey() {
    return `${this._redisKeyPrefix}:trade:${this._commitment}`
  }

  public async start() {
    logger.log('info', 'Streamer starting')
    this._heartbeatTimer = setInterval(async () => {
      console.log(`[streamer heartbeat] messages sent: ${this._messages_sent}`)
      // try if connecting to redis works fine
      this._redisCli.info().catch((e) => {
        logger.log('error', `redis heartbeat failed ${e?.message}`)
        throw e
      })
    }, 60 * 1000)

    logger.log('info', 'Connecting to redis')
    await this._redisCli.connect()
    logger.log('info', 'Connected to redis')

    serumDataChannel.onmessage = (message) => {
      //logger.log('error', 'Streamer rcv', message.data)
      this.processMessages(message.data)
    }
  }

  public async stop() {
    if (this._heartbeatTimer !== undefined) {
      clearInterval(this._heartbeatTimer)
    }
    await this._redisCli.quit()
  }

  private processMessages(messages: MessageEnvelope[]) {
    const receivedTs = new Date()

    for (const message of messages) {
      //const topic = `${message.type}-${message.market}`

      //const diff = new Date().valueOf() - new Date(message.timestamp).valueOf()
      //logger.log('debug', `Processing message, topic: ${topic}, receive delay: ${diff}ms`, meta)

      if (message.type === 'recent_trades') {
        const recentTrades = JSON.parse(message.payload)
        //console.log(recentTrades)
        for (let trade of recentTrades.trades) {
          // continue if id is already in cache
          if (this._cache.has(trade['id'])) {
            continue
          }

          //console.log(trade.timestamp)
          trade['timestamp_ms'] = new Date(trade.timestamp).getTime()
          trade['recent_timestamp_ms'] = new Date(message.timestamp).getTime()
          trade['recv_timestamp_ms'] = receivedTs.getTime()

          this._cache.put(trade['id'], trade)

          //logger.log('info', this.getTradeKey(trade['market']), trade)
          const key = this.getTradeKey()
          this._redisCli
            .xAdd(key, '*', trade)
            .then(() => {
              this._messages_sent += 1
              //logger.log('info', `sent trade to ${key}`)
            })
            .catch((e) => {
              logger.log('warn', `failed to send trade to ${key}: ${e?.message}`)
            })
        }
      }
    }
  }
}

const { redisURI, redisKeyPrefix, commitment } = workerData as {
  redisURI: string
  redisKeyPrefix: string
  commitment: string
}

const streamer = new Streamer(redisURI, redisKeyPrefix, commitment)

streamer.start()

cleanupChannel.onmessage = async () => {
  await streamer.stop()
}
