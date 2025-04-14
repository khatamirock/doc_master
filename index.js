// index.js
const express = require('express');
const multer = require('multer');
const { Readable } = require('stream');
const fs = require('fs').promises;
const { GoogleGenerativeAI } = require('@google/generative-ai');
const path = require('path');
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

function replaceFields(docText, fields) {
  let updatedText = docText;
  
  for (const field of fields) {
    // Escape special characters for regex
    const escapedValue = field.currentValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escapedValue, 'g');
    updatedText = updatedText.replace(regex, field.newValue);
  }
  
  // Optionally, you can add logic to handle the context before and after the field
  return updatedText;
}

app.post('/upload', upload.single('document'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).send('No file uploaded');
    }
    
    const docText = req.file.buffer.toString('utf8');
    const fields = await extractTemplateFields(docText);
    
    // Store the original document text in the session
    // In a real app, you might want to use a database or file storage
    await fs.writeFile(path.join(__dirname, 'temp', 'document.txt'), docText);
    
    res.json({ fields });
  } catch (error) {
    console.error('Error processing document:', error);
    res.status(500).send(`Error processing document: ${error.message}`);
  }
});

app.post('/generate', async (req, res) => {
  try {
    const { fields } = req.body;
    
    // Read the original document
    const docText = await fs.readFile(path.join(__dirname, 'temp', 'document.txt'), 'utf8');
    
    // Replace fields with new values
    const updatedDocText = replaceFields(docText, fields);
    
    // Send the updated document as a download
    res.setHeader('Content-Disposition', 'attachment; filename="updated_document.txt"');
    res.setHeader('Content-Type', 'text/plain');
    res.send(updatedDocText);
  } catch (error) {
    console.error('Error generating document:', error);
    res.status(500).send(`Error generating document: ${error.message}`);
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
