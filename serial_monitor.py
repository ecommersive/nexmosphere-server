#!/usr/bin/env python3
"""
Serial Monitor with WebSocket support
Reads from serial port and broadcasts to WebSocket server
Serves static files and WebSocket on the same port
"""

import serial
import asyncio
import json
import sys
import os
from datetime import datetime
from typing import Set
from aiohttp import web

# Configuration
SERIAL_PORT = 'COM4'  # Change this to your COM port
BAUD_RATE = 115200
WEBSOCKET_HOST = 'localhost'
WEBSOCKET_PORT = 3001
RATE_LIMIT_MS = 300  # 300ms between commands

# Store connected clients
connected_clients: Set = set()

# Command queue for rate limiting
command_queue = asyncio.Queue()
last_command_time = 0.0
is_processing_queue = False


async def serial_reader(ser):
    """
    Read from serial port and broadcast to WebSocket clients
    """
    try:
        print(f'[SERIAL] Connected to {ser.port} at {ser.baudrate} baud')
        
        while True:
            try:
                if ser.in_waiting > 0:
                    line = ser.readline().decode('utf-8', errors='ignore').strip()
                    if line:
                        timestamp = datetime.now().strftime('%H:%M:%S.%f')[:-3]
                        message = {
                            'timestamp': timestamp,
                            'data': line,
                            'type': 'serial_data'
                        }
                        print(f'[SERIAL-IN] {timestamp} - "{line}"')
                        
                        # Broadcast to all connected WebSocket clients
                        if connected_clients:
                            disconnected = set()
                            
                            for client in connected_clients:
                                try:
                                    await client.send_json(message)
                                    print(f'[WEBSOCKET-SEND] Broadcasting to {len(connected_clients)} client(s)')
                                except Exception as e:
                                    print(f'[WEBSOCKET-ERROR] Failed to send to client: {e}')
                                    disconnected.add(client)
                            
                            # Remove disconnected clients
                            connected_clients.difference_update(disconnected)
                
                await asyncio.sleep(0.01)  # Small delay to prevent CPU spinning
                
            except Exception as e:
                print(f'[SERIAL-ERROR] Read error: {e}')
                await asyncio.sleep(1)
    
    except Exception as e:
        print(f'[SERIAL-ERROR] Connection error: {e}')
        print(f'[SERIAL] Available ports: {get_available_ports()}')


async def process_command_queue(ser):
    """
    Process commands from the queue with rate limiting (300ms between commands)
    """
    global last_command_time, is_processing_queue
    
    while True:
        try:
            # Get the next command (blocking)
            command = await command_queue.get()
            
            # Check if we need to wait for rate limiting
            now = datetime.now().timestamp() * 1000  # Convert to milliseconds
            time_since_last = now - last_command_time
            delay_needed = RATE_LIMIT_MS - time_since_last
            
            if delay_needed > 0:
                print(f'[QUEUE] Rate limiting: waiting {delay_needed:.0f}ms')
                await asyncio.sleep(delay_needed / 1000)  # Convert back to seconds
            
            # Send the command
            try:
                formatted_command = command if command.endswith('\r\n') else command + '\r\n'
                ser.write(formatted_command.encode('utf-8'))
                last_command_time = datetime.now().timestamp() * 1000
                print(f'[SENT] Command sent to serial port: "{command}"')
            except Exception as e:
                print(f'[ERROR] Failed to send command: "{command}" | Error: {e}')
            
            command_queue.task_done()
            
        except Exception as e:
            print(f'[QUEUE-ERROR] {e}')
            await asyncio.sleep(0.1)


def get_available_ports():
    """Get list of available serial ports"""
    try:
        from serial.tools import list_ports
        ports = [port.device for port in list_ports.comports()]
        return ports if ports else ['None found']
    except Exception as e:
        print(f'[WARNING] Could not list ports: {e}')
        return ['COM3', 'COM4', 'COM5']  # Default fallback


async def load_and_queue_commands(filename='commands.nex'):
    """Load commands from file and queue them for execution"""
    try:
        if not os.path.exists(filename):
            print(f'[COMMANDS] No {filename} file found')
            return
        
        with open(filename, 'r') as f:
            lines = f.readlines()
        
        queued_count = 0
        for line in lines:
            stripped = line.strip()
            
            # Skip comment lines
            if stripped.startswith('#'):
                continue
            
            # Empty line = clear screen command
            if not stripped:
                await command_queue.put('CLEAR')
                queued_count += 1
                print(f'[COMMANDS] Queued command {queued_count}: "CLEAR" (empty line)')
            else:
                # Regular command
                await command_queue.put(stripped)
                queued_count += 1
                print(f'[COMMANDS] Queued command {queued_count}: "{stripped}"')
        
        if queued_count == 0:
            print(f'[COMMANDS] No commands found in {filename}')
        else:
            print(f'[COMMANDS] Loaded {queued_count} command(s) from {filename}')
    
    except Exception as e:
        print(f'[COMMANDS-ERROR] Failed to load commands: {e}')


async def websocket_handler(request):
    """
    Handle WebSocket connections
    """
    ws = web.WebSocketResponse()
    await ws.prepare(request)
    
    client_id = f'{request.remote}:{request.url.port if request.url.port else "unknown"}'
    connected_clients.add(ws)
    print(f'[WEBSOCKET] Client connected: {client_id} (Total: {len(connected_clients)})')
    
    try:
        async for msg in ws:
            if msg.type == web.WSMsgType.TEXT:
                print(f'[WEBSOCKET-MESSAGE] From {client_id}: {msg.data}')
            elif msg.type == web.WSMsgType.ERROR:
                print(f'[WEBSOCKET-ERROR] {ws.exception()}')
    
    except Exception as e:
        print(f'[WEBSOCKET-ERROR] {e}')
    finally:
        connected_clients.discard(ws)
        print(f'[WEBSOCKET] Client disconnected: {client_id} (Total: {len(connected_clients)})')
    
    return ws


async def send_command_handler(request):
    """
    Handle POST /send-command requests
    """
    try:
        data = await request.json()
        command = data.get('command', '').strip()
        
        if not command:
            return web.json_response({'error': 'Command is required'}, status=400)
        
        print(f'[INCOMING] POST /send-command received: "{command}"')
        
        # Add to command queue
        await command_queue.put(command)
        queue_size = command_queue.qsize()
        print(f'[QUEUE] Command queued: "{command}" | Queue size: {queue_size}')
        
        # Return success response
        return web.json_response({
            'success': True,
            'command': command,
            'queued': True,
            'queueSize': queue_size
        })
    
    except Exception as e:
        print(f'[HTTP-ERROR] Error handling /send-command: {e}')
        return web.json_response({'error': str(e)}, status=500)


async def queue_status_handler(request):
    """
    Handle GET /queue-status requests
    """
    return web.json_response({
        'queueLength': command_queue.qsize(),
        'isProcessing': not command_queue.empty(),
        'rateLimitMs': RATE_LIMIT_MS
    })


async def nextest_handler(request):
    """
    Serve nextest/index.html for /nextest route
    """
    nextest_path = os.path.join(os.path.dirname(__file__), 'nextest', 'index.html')
    if os.path.exists(nextest_path):
        with open(nextest_path, 'r') as f:
            return web.Response(text=f.read(), content_type='text/html')
    return web.Response(text='nextest/index.html not found', status=404)


async def main():
    """
    Main function - run serial reader and HTTP/WebSocket server
    """
    print(f'[STARTUP] Serial Monitor with WebSocket')
    print(f'[STARTUP] Serial Port: {SERIAL_PORT}')
    print(f'[STARTUP] Baud Rate: {BAUD_RATE}')
    print(f'[STARTUP] Rate Limit: {RATE_LIMIT_MS}ms between commands')
    print(f'[STARTUP] HTTP/WebSocket Server: http://{WEBSOCKET_HOST}:{WEBSOCKET_PORT}')
    print(f'[STARTUP] WebSocket: ws://{WEBSOCKET_HOST}:{WEBSOCKET_PORT}/ws')
    print(f'[STARTUP] Test Client: http://{WEBSOCKET_HOST}:{WEBSOCKET_PORT}/nextest')
    print(f'[STARTUP] Available ports: {get_available_ports()}')
    print()
    
    # Create aiohttp app
    app = web.Application()
    
    # Routes
    app.router.add_get('/ws', websocket_handler)
    app.router.add_post('/send-command', send_command_handler)
    app.router.add_get('/queue-status', queue_status_handler)
    
    # Serve static files from nextest directory first
    nextest_path = os.path.join(os.path.dirname(__file__), 'nextest')
    if os.path.exists(nextest_path):
        app.router.add_static('/nextest', path=nextest_path)
    
    # Start HTTP server
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, WEBSOCKET_HOST, WEBSOCKET_PORT)
    await site.start()
    
    print(f'[HTTP] Server started on http://{WEBSOCKET_HOST}:{WEBSOCKET_PORT}')
    
    # Open serial port for command processing
    try:
        ser = serial.Serial(SERIAL_PORT, BAUD_RATE, timeout=1)
        print(f'[SERIAL] Port opened for command processing')
    except Exception as e:
        print(f'[ERROR] Failed to open serial port: {e}')
        await runner.cleanup()
        return
    
    # Load commands from file
    await load_and_queue_commands()
    
    # Create tasks
    serial_reader_task = asyncio.create_task(serial_reader(ser))
    command_processor_task = asyncio.create_task(process_command_queue(ser))
    
    # Keep running
    try:
        await asyncio.gather(serial_reader_task, command_processor_task)
    except KeyboardInterrupt:
        print('\n[SHUTDOWN] Shutting down...')
        await runner.cleanup()
        ser.close()


if __name__ == '__main__':
    # Allow passing serial port as command line argument
    if len(sys.argv) > 1:
        SERIAL_PORT = sys.argv[1]
    
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print('\n[SHUTDOWN] Shutting down...')
