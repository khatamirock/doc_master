// index.js
const express = require('express');
const multer = require('multer');
const { Readable } = require('stream');
const fs = require('fs').promises;
const { GoogleGenerativeAI } = require('@google/generative-ai');
const path = require('path');
const { v4: uuidv4 } = require('uuid'); // Added for unique IDs
require('dotenv').config(); // Load environment variables

const app = express();
const port = process.env.PORT || 3000;
const upload = multer({ storage: multer.memoryStorage() });
const publicPath = path.join(__dirname, 'public');

app.use(express.static(publicPath));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Root route handler
app.get('/', (req, res) => {
  res.sendFile(path.join(publicPath, 'index.html'));
});

// Initialize Gemini AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API);

async function extractTemplateFields(docText) {
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });
  
  const prompt = `
  Analyze the following document text and identify all fields that might need to be changed 
  when using this as a template. For each field, provide detailed context:

  1. Identify the current value
  2. Describe what kind of data it is (name, date, address, etc.)
  3. Identify its position and surrounding context
  4. Suggest validation rules
  5. Note any dependencies with other fields
  6. Provide format requirements

  Return a JSON array of objects with these properties:
  {
    "fieldName": "human readable name",
    "currentValue": "value from document",
    "fieldType": "type of data",
    "position": "character position in document",
    "validationRules": ["rule1", "rule2"],
    "dependencies": ["related field names"],
    "format": "expected format description"
  }

  Document text:
  ${docText}
  `;

  const result = await model.generateContent(prompt);
  const response = await result.response;
  const text = response.text();
  
  try {
    const jsonMatch = text.match(/```json\n([\s\S]*?)\n```/) || text.match(/```\n([\s\S]*?)\n```/) || [null, text];
    const cleanJson = jsonMatch[1] || text;
    const fields = JSON.parse(cleanJson);

    // Add enhanced contextual information (5 words before/after)
    fields.forEach(field => {
      const words = docText.split(/(\s+)/); // Split by whitespace, keeping delimiters
      const fieldValueWords = field.currentValue.split(/(\s+)/);
      
      let startIndex = -1;
      let endIndex = -1;

      // Find the start and end index of the field value in the words array
      for (let i = 0; i <= words.length - fieldValueWords.length; i++) {
        let match = true;
        for (let j = 0; j < fieldValueWords.length; j++) {
          if (words[i + j] !== fieldValueWords[j]) {
            match = false;
            break;
          }
        }
        if (match) {
          startIndex = i;
          endIndex = i + fieldValueWords.length -1;
          break;
        }
      }

      let contextBeforeWords = [];
      let contextAfterWords = [];

      if (startIndex !== -1) {
        // Get 5 words before (ignoring whitespace entries)
        let wordsFound = 0;
        for (let i = startIndex - 1; i >= 0 && wordsFound < 5; i--) {
          if (words[i].trim().length > 0) { // Check if it's a non-empty word
             contextBeforeWords.unshift(words[i]);
             wordsFound++;
          } else if (contextBeforeWords.length > 0) { // Keep whitespace between words
             contextBeforeWords.unshift(words[i]);
          }
        }

        // Get 5 words after (ignoring whitespace entries)
        wordsFound = 0;
        for (let i = endIndex + 1; i < words.length && wordsFound < 5; i++) {
           if (words[i].trim().length > 0) { // Check if it's a non-empty word
             contextAfterWords.push(words[i]);
             wordsFound++;
           } else if (contextAfterWords.length > 0) { // Keep whitespace between words
             contextAfterWords.push(words[i]);
           }
        }
      }
      
      // Store enhanced context
      field.contextBefore = contextBeforeWords.join('');
      field.contextAfter = contextAfterWords.join('');
      // Ensure context doesn't include the field value itself if it was captured due to splitting
      field.fullContext = `...${field.contextBefore.trim()} **${field.currentValue}** ${field.contextAfter.trim()}...`;

      // Add default validation if not provided
      if (!field.validationRules) {
        field.validationRules = getDefaultValidationRules(field.fieldType);
      }
    });

    return fields;
  } catch (error) {
    console.error("Failed to parse JSON from AI response:", error);
    console.log("Raw response:", text);
    throw new Error("Failed to extract fields from document");
  }
}

function getDefaultValidationRules(fieldType) {
  const rules = {
    'date': ['must be a valid date', 'must be in format DD Month, YYYY'],
    'email': ['must be a valid email address', 'must contain @ symbol'],
    'phone': ['must include country code', 'must be in international format'],
    'name': ['must not be empty', 'should not contain numbers'],
    'address': ['must include street address', 'should include ZIP/postal code'],
    'amount': ['must be a valid number', 'should include currency symbol'],
    'default': ['must not be empty']
  };
  return rules[fieldType.toLowerCase()] || rules.default;
}

// This function runs the AI extraction and saves results/errors
async function processDocumentInBackground(taskId, docBuffer) {
  const resultPath = path.join(__dirname, 'temp', `${taskId}.json`);
  const errorPath = path.join(__dirname, 'temp', `${taskId}.error`);
  const docText = docBuffer.toString('utf8'); // Convert buffer to text here

  try {
    console.log(`[${taskId}] Starting extraction...`);
    const fields = await extractTemplateFields(docText);
    await fs.writeFile(resultPath, JSON.stringify({ status: 'complete', fields }));
    console.log(`[${taskId}] Extraction complete. Results saved.`);
    // Clean up error file if process succeeded
    try { await fs.unlink(errorPath); } catch (e) { /* ignore if file doesn't exist */ }
  } catch (error) {
    console.error(`[${taskId}] Error processing document:`, error);
    const errorMessage = `Error processing document: ${error.message}`;
    await fs.writeFile(errorPath, JSON.stringify({ status: 'error', message: errorMessage }));
     // Clean up result file if process failed
    try { await fs.unlink(resultPath); } catch (e) { /* ignore if file doesn't exist */ }
  }
}

app.post('/upload', upload.single('document'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: 'No file uploaded' });
  }

  const taskId = uuidv4();
  const tempDocPath = path.join(__dirname, 'temp', `${taskId}.txt`); // Keep original doc temporarily if needed for other ops, or just pass buffer
  const statusPath = path.join(__dirname, 'temp', `${taskId}.json`); // Path for status/results

  try {
    // Save the original document buffer temporarily (optional, could pass buffer directly)
    // await fs.writeFile(tempDocPath, req.file.buffer);

    // Create initial status file
    await fs.writeFile(statusPath, JSON.stringify({ status: 'processing' }));

    // Start background processing - IMPORTANT: no 'await' here
    processDocumentInBackground(taskId, req.file.buffer);

    // Respond immediately with the task ID
    res.status(202).json({ taskId }); // 202 Accepted indicates processing started
    console.log(`[${taskId}] Upload received, processing started in background.`);

  } catch (error) {
    console.error(`[${taskId}] Error initiating upload process:`, error);
    res.status(500).json({ message: `Error initiating document processing: ${error.message}` });
  }
});

// Endpoint to check the status of a task
app.get('/status/:taskId', async (req, res) => {
  const taskId = req.params.taskId;
  const resultPath = path.join(__dirname, 'temp', `${taskId}.json`);
  const errorPath = path.join(__dirname, 'temp', `${taskId}.error`);

  try {
    // Check for error file first
    await fs.access(errorPath);
    const errorData = await fs.readFile(errorPath, 'utf8');
    res.status(200).json(JSON.parse(errorData)); // Send error status
  } catch (error) {
    // Error file doesn't exist, check for result file
    try {
      await fs.access(resultPath);
      const resultData = await fs.readFile(resultPath, 'utf8');
      res.status(200).json(JSON.parse(resultData)); // Send complete status + results
    } catch (resultError) {
      // Neither file exists, assume still processing
      res.status(200).json({ status: 'processing' });
    }
  }
});

// Endpoint to get the results of a completed task (redundant if status includes results)
// Kept separate for clarity, could be merged into /status logic
app.get('/results/:taskId', async (req, res) => {
    const taskId = req.params.taskId;
    const resultPath = path.join(__dirname, 'temp', `${taskId}.json`);

    try {
        const resultData = await fs.readFile(resultPath, 'utf8');
        const results = JSON.parse(resultData);
        if (results.status === 'complete') {
            res.status(200).json(results); // Send only if complete
        } else {
            // Should ideally not happen if client checks status first
            res.status(404).json({ message: 'Results not ready or task failed.' });
        }
    } catch (error) {
        console.error(`[${taskId}] Error fetching results:`, error);
        res.status(404).json({ message: 'Results not found or task failed.' });
    }
});


// Make sure temp directory exists
app.listen(port, async () => {
  try {
    await fs.mkdir(path.join(__dirname, 'temp'), { recursive: true });
    console.log(`Server running on port ${port}`);
  } catch (error) {
    console.error('Failed to create temp directory:', error);
  }
});

module.exports = app;
