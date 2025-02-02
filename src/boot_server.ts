import os from 'os'
import path from 'path'
import { Worker } from 'worker_threads'
import { cleanupChannel, minionReadyChannel, serumProducerReadyChannel, wait } from './helpers'
import { logger } from './logger'
import { SerumMarket } from './types'

export async function bootServer({
  port,
  nodeEndpoint,
  wsEndpointPort,
  minionsCount,
  markets,
  commitment,
  bootDelay,
  mongoURI,
  mongoDBName,
  redisURI,
  redisKeyPrefix
}: BootOptions) {
  // multi core support is linux only feature which allows multiple threads to bind to the same port
  // see https://github.com/uNetworking/uWebSockets.js/issues/304 and https://lwn.net/Articles/542629/
  const MINIONS_COUNT = os.platform() === 'linux' ? minionsCount : 1
  let readyMinionsCount = 0

  logger.log(
    'info',
    MINIONS_COUNT === 1 ? 'Starting single minion worker...' : `Starting ${MINIONS_COUNT} minion workers...`
  )
  minionReadyChannel.onmessage = () => readyMinionsCount++

  // start minions workers and wait until all are ready

  for (let i = 0; i < MINIONS_COUNT; i++) {
    const minionWorker = new Worker(path.resolve(__dirname, 'minion.js'), {
      workerData: { nodeEndpoint, port, markets, minionNumber: i }
    })

    minionWorker.on('error', (err) => {
      logger.log('error', `Minion worker ${minionWorker.threadId} error occurred: ${err.message} ${err.stack}`)
      throw err
    })
    minionWorker.on('exit', (code) => {
      logger.log('error', `Minion worker: ${minionWorker.threadId} died with code: ${code}`)
    })
  }

  await new Promise<void>(async (resolve) => {
    while (true) {
      if (readyMinionsCount === MINIONS_COUNT) {
        break
      }
      await wait(100)
    }

    resolve()
  })

  // exporter
  if (!mongoURI || !mongoDBName) {
    logger.log('warn', `disabling exporter: mongo params not specified: ${mongoURI} / ${mongoDBName}`)
  } else {
    logger.log('info', 'Starting exporter worker...')
    const exporterWorker = new Worker(path.resolve(__dirname, 'exporter.js'), {
      workerData: { mongoURI, mongoDBName, commitment }
    })
    exporterWorker.on('error', (err) => {
      logger.log('error', `Exporter error occurred: ${err.message} ${err.stack}`)
      throw err
    })
    exporterWorker.on('exit', (code) => {
      logger.log('error', `Exporter worker died with code ${code}`)
    })
  }

  // streamer
  if (!redisURI || !redisKeyPrefix) {
    logger.log('warn', `disabling streamer: redis params not specified: ${redisURI}, ${redisKeyPrefix}`)
  } else {
    logger.log('info', 'Starting streamer worker...')
    const streamerWorker = new Worker(path.resolve(__dirname, 'streamer.js'), {
      workerData: { redisURI, redisKeyPrefix, commitment }
    })
    streamerWorker.on('error', (err) => {
      logger.log('error', `Streamer error occurred: ${err.message} ${err.stack}`)
      throw err
    })
    streamerWorker.on('exit', (code) => {
      logger.log('error', `Streamer worker died with code ${code}`)
    })
  }

  logger.log('info', `Starting serum producers for ${markets.length} markets, rpc endpoint: ${nodeEndpoint}`)

  let readyProducersCount = 0

  serumProducerReadyChannel.onmessage = () => readyProducersCount++

  for (const market of markets) {
    const serumProducerWorker = new Worker(path.resolve(__dirname, 'serum_producer.js'), {
      workerData: { market, nodeEndpoint, commitment, wsEndpointPort }
    })

    serumProducerWorker.on('error', (err) => {
      logger.log(
        'error',
        `Serum producer worker ${serumProducerWorker.threadId} error occurred: ${err.message} ${err.stack}`
      )
      throw err
    })

    serumProducerWorker.on('exit', (code) => {
      logger.log('error', `Serum producer worker: ${serumProducerWorker.threadId} died with code: ${code}`)
    })

    // just in case to not get hit by serum RPC node rate limits...
    await wait(bootDelay)
  }

  await new Promise<void>(async (resolve) => {
    while (true) {
      if (readyProducersCount === markets.length) {
        break
      }
      await wait(100)
    }

    resolve()
  })
}

export async function stopServer() {
  cleanupChannel.postMessage('cleanup')

  await wait(10 * 1000)
}

type BootOptions = {
  port: number
  nodeEndpoint: string
  wsEndpointPort: number | undefined
  minionsCount: number
  commitment: string
  markets: SerumMarket[]
  bootDelay: number
  mongoURI: string
  mongoDBName: string
  redisURI: string
  redisKeyPrefix: string
}
