const { SerialPort } = require('serialport');

async function listPorts() {
	const ports = await SerialPort.list();

	if (ports.length === 0) {
		console.log('No serial ports found.');
		return;
	}

	console.log('\nAvailable COM Ports:\n');
	console.log('─'.repeat(60));
	
	ports.forEach((port, index) => {
		console.log(`[${index + 1}] ${port.path}`);
		if (port.friendlyName) console.log(`    Name: ${port.friendlyName}`);
		if (port.manufacturer) console.log(`    Manufacturer: ${port.manufacturer}`);
		if (port.serialNumber) console.log(`    Serial: ${port.serialNumber}`);
		if (port.vendorId) console.log(`    Vendor ID: ${port.vendorId}`);
		if (port.productId) console.log(`    Product ID: ${port.productId}`);
		console.log('─'.repeat(60));
	});

	console.log(`\nTotal: ${ports.length} port(s) found`);
	console.log('\nUsage: bun index.js <port_number>');
	console.log('Example: bun index.js 4  (for COM4 on Windows)\n');
}

listPorts().catch(err => {
	console.error('Error listing ports:', err.message);
	process.exit(1);
});
