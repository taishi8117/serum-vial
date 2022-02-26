#!/usr/bin/env python3

import asyncio
import json
import sys

import aioredis


async def tail(url, key, dict_key=None):
    redis_cli = aioredis.from_url(url, encoding='utf8')
    last_id = '$'

    while True:
        events = await redis_cli.xread({
            key: last_id,
        }, block=100)
        for _, e in events:
            score, rawdata = e[0]
            try:
                data = json.loads(rawdata)

                if dict_key:
                    print(score.decode(), data[dict_key], flush=True)
                else:
                    print(score.decode(), data, flush=True)
            except:
                print(score.decode(), rawdata)
            finally:
                last_id = score


if len(sys.argv) < 2:
    print(f"{sys.argv[0]} [REDIS URL] [REDIS KEY] [dict_key?]")
    sys.exit(1)

redis_url = sys.argv[1]
redis_key = sys.argv[2]
dict_key = None
if len(sys.argv) == 4:
    dict_key = sys.argv[3]

loop = asyncio.get_event_loop()
loop.run_until_complete(tail(redis_url, redis_key, dict_key))
