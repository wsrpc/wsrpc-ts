"""Real bidirectional interoperability against both Python implementations."""

import asyncio
import socket
from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn
from aiohttp import web
from aiohttp.test_utils import TestServer
from wsrpc_aiohttp import (
    ClientException as AiohttpError,
    WebSocketAsync as AiohttpServer,
    WSRPCClient as AiohttpClient,
)
from wsrpc_asgi import (
    ClientException as ASGIError,
    WebSocketAsync as ASGIServer,
    WSRPCClient as ASGIClient,
)

ROOT = Path(__file__).resolve().parents[1]


async def echo(socket, **params):
    return params


async def reverse(socket, value):
    return await socket.proxy.double(value=value)


async def fail(socket):
    raise ValueError("Python failure")


@asynccontextmanager
async def asgi_server(app):
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen(128)
    port = listener.getsockname()[1]
    server = uvicorn.Server(
        uvicorn.Config(app, log_level="error", ws="websockets-sansio")
    )
    task = asyncio.create_task(server.serve(sockets=[listener]))
    try:
        for _ in range(500):
            if server.started:
                break
            if task.done():
                await task
                raise RuntimeError("ASGI startup failed")
            await asyncio.sleep(0.01)
        else:
            raise TimeoutError("ASGI startup timed out")
        yield f"ws://127.0.0.1:{port}/ws/"
    finally:
        server.should_exit = True
        try:
            await asyncio.wait_for(task, 5)
        finally:
            listener.close()


async def node_client(url):
    process = await asyncio.create_subprocess_exec(
        "node",
        "build/tests/interop-client.js",
        url,
        cwd=ROOT,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        output, errors = await asyncio.wait_for(process.communicate(), 10)
        assert process.returncode == 0, errors.decode()
        assert b"interoperability passed" in output
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()


async def python_clients(url):
    for base, exception in [(AiohttpClient, AiohttpError), (ASGIClient, ASGIError)]:

        class Client(base):
            pass

        Client.add_route("double", lambda socket, value: value * 2)
        async with Client(url, timeout=3) as client:
            assert await client.proxy.echo(text="Привет 🐍", value=0) == {
                "text": "Привет 🐍",
                "value": 0,
            }
            assert await client.proxy.reverse(value=21) == 42
            assert await client.proxy.counter(value=10) == 10
            assert await client.proxy.counter.add(value=2) == 12
            try:
                await client.proxy.fail()
            except exception:
                pass
            else:
                raise AssertionError("Remote failure must raise")
        print(f"{base.__module__.split('.')[0]} client -> TypeScript server: passed")


async def main():
    process = await asyncio.create_subprocess_exec(
        "node",
        "build/tests/interop-server.js",
        cwd=ROOT,
        stdout=asyncio.subprocess.PIPE,
    )
    try:
        url = (await asyncio.wait_for(process.stdout.readline(), 5)).decode().strip()
        assert url.startswith("ws://"), url
        await python_clients(url)
    finally:
        if process.returncode is None:
            process.terminate()
            try:
                await asyncio.wait_for(process.wait(), 5)
            except asyncio.TimeoutError:
                process.kill()
                await process.wait()

    class Aiohttp(AiohttpServer):
        pass

    class ASGI(ASGIServer):
        pass

    for handler in [Aiohttp, ASGI]:
        handler.add_route("echo", echo)
        handler.add_route("reverse", reverse)
        handler.add_route("fail", fail)
    app = web.Application()
    app.router.add_get("/ws/", Aiohttp)
    async with TestServer(app) as server:
        await node_client(str(server.make_url("/ws/")))
        print("TypeScript client -> wsrpc_aiohttp server: passed")
    async with asgi_server(ASGI.as_asgi(path="/ws/")) as url:
        await node_client(url)
        print("TypeScript client -> wsrpc_asgi server: passed")


if __name__ == "__main__":
    asyncio.run(asyncio.wait_for(main(), 45))
