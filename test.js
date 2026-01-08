const express = require('express');
const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const { WebSocketServer } = require('ws');
const sound = require("sound-play");

const path = require("path");
const mistpath = path.join(__dirname, 'sounds', "mist.wav");
const maskpath = path.join(__dirname, 'sounds', "mask.wav");

const app = express();
app.use(express.json());

app.get('/playmist', async (req, res) => {
	await sound.play(mistpath);
	res.status(200).send('Played mist');
})
app.get('/playmask', async (req, res) => {
	await sound.play(maskpath);
	res.status(200).send('played mask');
})


app.listen(3001, () => {
});


// Serve the HTML file
app.use(express.static(path.join(__dirname, 'public')));
