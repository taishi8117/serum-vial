import { isMainThread, threadId, workerData } from 'worker_threads'
import { cleanupChannel, serumDataChannel, serumMarketsChannel } from './helpers'
import { logger } from './logger'
import { MessageEnvelope } from './serum_producer'
import { MongoClient } from 'mongodb'

const meta = {
  minionId: threadId
}

if (isMainThread) {
  const message = 'Exiting. Worker is not meant to run in main thread'
  logger.log('error', message, meta)

  throw new Error(message)
}

class Exporter {
  private _quotesBuffer: any[] = []
  private _tradesBuffer: any[] = []

  private _dbWriteTimer: NodeJS.Timeout | undefined = undefined
  private _mongoCli: MongoClient | undefined = undefined

  private MONGO_DBNAME = 'serum_market'

  constructor(_mongoURI: string) {
    this._mongoCli = new MongoClient(_mongoURI)
  }

  public async start() {
    logger.log('info', 'Exporter starting')
    this._dbWriteTimer = setInterval(async () => {
      await this._writeToDB()
    }, 5 * 1000)

    serumDataChannel.onmessage = (message) => {
      //logger.log('error', 'exporter rcv', message.data)
      this.processMessages(message.data)
    }
  }

  public async stop() {
    if (this._dbWriteTimer !== undefined) {
      clearInterval(this._dbWriteTimer)
    }
  }

  private processMessages(messages: MessageEnvelope[]) {
    const receivedTs = new Date()

    for (const message of messages) {
      //const topic = `${message.type}-${message.market}`

      //const diff = new Date().valueOf() - new Date(message.timestamp).valueOf()
      //logger.log('debug', `Processing message, topic: ${topic}, receive delay: ${diff}ms`, meta)

      if (message.type === 'quote') {
        const quote = JSON.parse(message.payload)
        quote['timestamp'] = new Date(message.timestamp)
        quote['recv_timestamp'] = receivedTs
        //logger.log('info', 'quote', payload)
        //console.log(quote)
        this._quotesBuffer.push(quote)
      }

      if (message.type === 'recent_trades') {
        const recentTrades = JSON.parse(message.payload)
        //console.log(recentTrades)
        for (let trade of recentTrades.trades) {
          //console.log(trade.timestamp)
          trade['timestamp'] = new Date(trade.timestamp)
          trade['recent_timestamp'] = new Date(message.timestamp)
          trade['recv_timestamp'] = receivedTs
          this._tradesBuffer.push(trade)
        }
      }
    }
  }

  private async _writeToDB() {
    // for now create a connection every time
    try {
      await this._mongoCli?.connect()

      logger.log('info', `writing quotesBuffer to mongo with size: ${this._quotesBuffer.length}`)
      if (this._quotesBuffer.length > 0) {
        await this._mongoCli?.db(this.MONGO_DBNAME).collection('quotes').insertMany(this._quotesBuffer)
        this._quotesBuffer = []
      }

      logger.log('info', `writing tradesBuffer to mongo with size: ${this._tradesBuffer.length}`)
      if (this._tradesBuffer.length > 0) {
        const tradesUniq = this._tradesBuffer.filter((v, i, a) => a.findIndex((t) => t.id === v.id) === i)
        this._tradesBuffer = []
        try {
          await this._mongoCli?.db(this.MONGO_DBNAME).collection('trades').insertMany(tradesUniq, { ordered: false })
        } catch (err) {
          if ((err as any).code === 11000) {
            //logger.log('info', 'duplicates', err)
          } else {
            throw err
          }
        }
      }
    } catch (err) {
      logger.log('error', `error while writing to db: ${err}`)
      throw err
    } finally {
      await this._mongoCli?.close()
    }
  }
}

const { mongoURI } = workerData as {
  mongoURI: string
}

const exporter = new Exporter(mongoURI)

exporter.start()

cleanupChannel.onmessage = async () => {
  await exporter.stop()
}
