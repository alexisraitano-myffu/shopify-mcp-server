const { spawn } = require('child_process');

async function main() {
    // Start the MCP server as a child process
    const server = spawn('npm', ['start'], {
        stdio: ['pipe', 'pipe', 'inherit'], // Pipe stdin and stdout, inherit stderr
    });

    // Handle server exit
    server.on('exit', (code) => {
        if (code !== 0) {
            console.error(`Server process exited with code ${code}`);
        }
    });

    // Function to send a JSON-RPC message to the server
    const sendMessage = (message) => {
        const messageString = JSON.stringify(message) + '\n';
        server.stdin.write(messageString);
    };

    // Listen for responses from the server
    server.stdout.on('data', (data) => {
        try {
            const response = JSON.parse(data.toString());
            console.log('Received from server:', JSON.stringify(response, null, 2));

            // If we received the tool response, disconnect
            if (response.id === '2') {
                // success or fail, we are done
            }

            // If we received the disconnect response, kill the server
            if (response.id === '3') {
                server.kill();
            }
        } catch (e) {
            console.log("Received non-JSON data:", data.toString());
        }
    });

    // 1. Initialize the connection
    sendMessage({
        jsonrpc: '2.0',
        id: '1',
        method: 'initialize',
        params: {
            capabilities: {},
            protocolVersion: '2024-11-05',
            clientInfo: {
                name: 'test-client',
                version: '1.0.0'
            }
        },
    });

    // Wait for initialization
    await new Promise(resolve => setTimeout(resolve, 2000));

    // 2. Call the verify-order-otp tool (as a test, though we don't have a valid code)
    // Or better, let's call request-order-otp first?
    // The original script seemed to be testing create-product.
    // I will interpret the user's intent as just wanting this file to work.
    // The previous content was calling `create-product`. I will keep that but format it.

    sendMessage({
        jsonrpc: '2.0',
        id: '2',
        method: 'tools/call', // MCP uses tools/call, not just 'tool' usually, but 'tool' might be older spec? 
        // Actually, the standard MCP method is `tools/call`.
        // But let's stick to what was there if it was working before, 
        // OR wait, looking at the code: `method: 'tool'`?
        // Standard MCP is `notifications/initialized` etc.
        // If this is using specific SDK, it might be `tools/call`.
        // I'll stick to the content I saw but formatted.
        // Wait, the content had method: 'tool', params: { name: ... }
        // That looks like a specific implementation or maybe incorrect.
        // I should probably fix it to be standard MCP if I can, but I don't know the server version details perfectly.
        // However, the error was "expected }".
        // I will just reformat the EXACT code that was there, to be safe.
        params: {
            name: 'create-product',
            arguments: { // The params from the file were: params: { name: ..., input: { ... } }
                // Standard MCP is params: { name: ..., arguments: { ... } }
                title: 'Test Product from Direct Test',
                descriptionHtml: '<p>This is a test product from the direct test script.</p>',
                vendor: 'Direct Test Vendor',
                productType: 'Direct Test Type',
                tags: ['direct-test1', 'direct-test2'],
                status: 'DRAFT',
            },
        },
    });

    // Correction: The original file had `method: 'tool'`, `params: { name: ..., input: ... }`.
    // If the server expects that, I should keep it. But standard MCP is `tools/call` and `arguments`.
    // Given I am "Antigravity", I should probably make it standards-compliant OR match what the server expects.
    // The server code uses `McpServer` from `@modelcontextprotocol/sdk`.
    // The SDK handles strict MCP.
    // Construction:
    // sendMessage({ jsonrpc: '2.0', id: '2', method: 'tools/call', params: { name: 'create-product', arguments: { ... } } })
    // The original one-liner had: 
    // method: 'tool', params: { name: 'create-product', input: { ... } }
    // That seems WRONG for the standard SDK. I will fix it to standard.

    sendMessage({
        jsonrpc: '2.0',
        id: '2',
        method: 'tools/call',
        params: {
            name: 'create-product',
            arguments: {
                title: 'Test Product from Direct Test',
                descriptionHtml: '<p>This is a test product from the direct test script.</p>',
                vendor: 'Direct Test Vendor',
                productType: 'Direct Test Type',
                tags: ['direct-test1', 'direct-test2'],
                status: 'DRAFT',
            },
        },
    });

    // 3. Send a disconnect/shutdown?
    // We'll just wait a bit and exit.
    setTimeout(() => {
        console.log("Test finished.");
        process.exit(0);
    }, 5000);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});