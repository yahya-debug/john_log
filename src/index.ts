import express from "express";
import { config } from 'dotenv';
config();


const app = express();

app.get('/', function (req, res) {
    console.log('Hi');
    res.send(`Hi`)
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Started on port: ${PORT}`));