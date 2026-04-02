require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const bodyParser = require('body-parser');
const { MASTER_PROMPT } = require('./prompts');
const { generateQuickQueryResponse, generateDetailedPlanConversation, fetchLocalDataMock } = require('./services');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(express.static('public'));

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);


const PORT = process.env.PORT || 3000;

// Simple in-memory session store (In production, use Redis or DB)
const callMemory = {};

// Helper to get or init session
function getSession(callSid) {
    if (!callMemory[callSid]) {
        callMemory[callSid] = {
            params: {}, // Will store {name, location, pastCrop, currentIdea, soil, terrain}
            mode: null,
            lang: 'en-US'
        };
    }
    return callMemory[callSid];
}

// ============================================
// TWILIO VOICE ROUTES
// ============================================

app.post('/voice/entry', (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    const gather = twiml.gather({ numDigits: 1, action: '/voice/language-selection', method: 'POST' });
    gather.say('Welcome to AgriSpark. For English, press 1. สำหรับภาษาไทย กด 2.');
    twiml.redirect('/voice/entry');

    res.type('text/xml');
    res.send(twiml.toString());
});

app.post('/voice/language-selection', (req, res) => {
    const digits = req.body.Digits;
    const callSid = req.body.CallSid;
    const twiml = new twilio.twiml.VoiceResponse();
    
    let langCode = digits === '2' ? 'th-TH' : 'en-US';
    getSession(callSid).lang = langCode;
    
    const gather = twiml.gather({ numDigits: 1, action: `/voice/mode-selection`, method: 'POST' });
    
    if (langCode === 'th-TH') {
        gather.say({ language: langCode }, 'สำหรับคำถามด่วน กด 1. สำหรับแผนงานเพาะปลูกแบบละเอียด กด 2.');
    } else {
        gather.say({ language: langCode }, 'For a quick query, press 1. For a detailed farming plan, press 2.');
    }
    
    twiml.redirect(`/voice/language-selection`);
    res.type('text/xml');
    res.send(twiml.toString());
});

app.post('/voice/mode-selection', (req, res) => {
    const digits = req.body.Digits;
    const callSid = req.body.CallSid;
    const session = getSession(callSid);
    const twiml = new twilio.twiml.VoiceResponse();
    
    if (digits === '1') {
        session.mode = 'quick';
        twiml.say({ language: session.lang }, session.lang === 'th-TH' ? 'กรุณาพูดคำถามของคุณหลังเสียงสัญญาณค่ะ' : 'Please say your question after the beep.');
        twiml.record({ action: `/voice/quick-query-process`, maxLength: 30, playBeep: true, transcribe: true });
    } else if (digits === '2') {
        session.mode = 'detailed';
        twiml.say({ language: session.lang }, session.lang === 'th-TH' ? 'เราจะมาสร้างแผนการเพาะปลูกให้คุณนะคะ กรุณาบอกชื่อของคุณค่ะ' : 'Let us create a detailed plan. Please tell me your name.');
        twiml.record({ action: `/voice/detailed-plan-process`, maxLength: 15, playBeep: true, transcribe: true });
    } else {
        twiml.say({ language: session.lang }, 'Invalid choice.');
        twiml.redirect('/voice/entry');
    }

    res.type('text/xml');
    res.send(twiml.toString());
});

// Process Quick Query Audio
app.post('/voice/quick-query-process', async (req, res) => {
    const callSid = req.body.CallSid;
    const session = getSession(callSid);
    // Note: Twilio sends 'SpeechResult' if transcription is used (needs Gather instead of Record for real-time, or checking TranscriptionText)
    // For simplicity in this demo, let's assume we use Gather with speech input or get SpeechResult
    // Since we used Record, 'TranscriptionText' comes later. Let's redirect to a Gather for proper Speech-To-Text.
    
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say({ language: session.lang }, 'Analyzing your question...');
    
    // In a real app we'd wait for the async transcription callback, 
    // but for the sake of this code, let's pretend req.body.SpeechResult is available.
    // If not, we ask them to use Gather.
    twiml.redirect('/voice/quick-query-gather');
    res.type('text/xml');
    res.send(twiml.toString());
});

// Actually using Gather for Speech to Text is much faster and sync than Record Transcription
app.post('/voice/quick-query-gather', (req, res) => {
    const session = getSession(req.body.CallSid);
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.gather({
        input: 'speech',
        action: '/voice/quick-query-answer',
        language: session.lang,
        speechTimeout: 'auto'
    }).say({ language: session.lang }, session.lang === 'th-TH' ? 'กรุณาพูดคำถามค่ะ' : 'I am listening.');
    res.type('text/xml');
    res.send(twiml.toString());
});

app.post('/voice/quick-query-answer', async (req, res) => {
    const session = getSession(req.body.CallSid);
    const speechResult = req.body.SpeechResult;
    const twiml = new twilio.twiml.VoiceResponse();

    if (speechResult) {
        const answer = await generateQuickQueryResponse(speechResult, session.lang);
        twiml.say({ language: session.lang }, answer);
        
        // Ask if they have another question
        twiml.gather({
            input: 'speech',
            action: '/voice/quick-query-answer',
            language: session.lang,
            speechTimeout: 'auto'
        }).say({ language: session.lang }, session.lang === 'th-TH' ? 'มีคำถามอื่นอีกไหมคะ?' : 'Do you have another question?');
    } else {
        twiml.redirect('/voice/quick-query-gather');
    }

    res.type('text/xml');
    res.send(twiml.toString());
});

// Process Detailed Plan Gather
app.post('/voice/detailed-plan-gather', (req, res) => {
    const session = getSession(req.body.CallSid);
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.gather({
        input: 'speech',
        action: '/voice/detailed-plan-process',
        language: session.lang,
        speechTimeout: 'auto'
    });
    res.type('text/xml');
    res.send(twiml.toString());
});

app.post('/voice/detailed-plan-process', async (req, res) => {
    const callSid = req.body.CallSid;
    const session = getSession(callSid);
    const speechResult = req.body.SpeechResult || 'Unknown response'; // from Gather
    const twiml = new twilio.twiml.VoiceResponse();

    // Give LLM the utterance and let it naturally extract and formulate next question
    const nextAgentResponse = await generateDetailedPlanConversation(session.params, speechResult, session.lang);

    // Naive Check for completion text in agent's response to simulate triggering the PDF
    if (nextAgentResponse.toLowerCase().includes('whatsapp') || nextAgentResponse.toLowerCase().includes('pdf')) {
        twiml.say({ language: session.lang }, nextAgentResponse);
        twiml.say({ language: session.lang }, session.lang === 'th-TH' ? 'ขอบคุณที่ใช้บริการ ลาก่อนค่ะ' : 'Thank you for using AgriSpark. Goodbye.');
        twiml.hangup();
        
        // Asynchronously Trigger PDF + WhatsApp/SMS Dispatch here...
        console.log("Triggering PDF generation based on gathered data:", session.params);
    } else {
        // If not completed, say the next question and Gather speech again
        const gather = twiml.gather({
            input: 'speech',
            action: '/voice/detailed-plan-process',
            language: session.lang,
            speechTimeout: 'auto'
        });
        gather.say({ language: session.lang }, nextAgentResponse);
    }

    res.type('text/xml');
    res.send(twiml.toString());
});

app.post('/whatsapp/chat', async (req, res) => {
    const textMsg = req.body.Body || '';
    const numMedia = parseInt(req.body.NumMedia || 0);
    const hasMedia = numMedia > 0;
    
    const { generateVisionDiagnostic } = require('./services');
    // Using English as default for WA demo unless Thai char detected
    const isThai = /[\u0E00-\u0E7F]/.test(textMsg);
    const lang = isThai ? 'th-TH' : 'en-US';
    
    const answer = await generateVisionDiagnostic(textMsg, hasMedia, lang);

    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(answer);
    res.type('text/xml');
    res.send(twiml.toString());
});

// ============================================
// API ROUTES FOR FRONTEND
// ============================================

app.post('/api/call', async (req, res) => {
    const { phoneNumber } = req.body;
    if (!phoneNumber) return res.status(400).json({ success: false, error: 'Phone number required.' });

    try {
        const call = await client.calls.create({
            url: `${process.env.VERCEL_URL || 'http://localhost:3000'}/voice/entry`,
            to: phoneNumber,
            from: process.env.TWILIO_PHONE_NUMBER
        });
        console.log(`Initiated call to ${phoneNumber}, Sid: ${call.sid}`);
        res.json({ success: true, callSid: call.sid });
    } catch (error) {
        console.error('Twilio Call Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});


app.listen(PORT, () => {
    console.log(`AgriSpark server running on port ${PORT}`);
});
