// index.js
const express = require('express');
const multer = require('multer');
const { Readable } = require('stream');
const fs = require('fs').promises;
const { GoogleGenerativeAI } = require('@google/generative-ai');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Initialize Gemini AI
const genAI = new GoogleGenerativeAI('AIzaSyDgDe_5niOFm5ykcnXd6eb4RcLNhdAr5fs');

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
    "context": "20 chars before and after",
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

    // Add enhanced contextual information
    fields.forEach(field => {
      // Find word boundaries for better context
      const words = docText.split(/\b/);
      const fieldStartIndex = docText.indexOf(field.currentValue);
      
      // Find 5 words before and after
      let beforeWords = [];
      let afterWords = [];
      let wordCount = 0;
      let currentIndex = 0;
      
      // Get words before
      for (let i = 0; i < words.length && wordCount < 5; i++) {
        currentIndex += words[i].length;
        if (currentIndex >= fieldStartIndex) break;
        if (/\w+/.test(words[i])) {
          beforeWords.push(words[i]);
          wordCount++;
        }
      }
      
      // Get words after
      wordCount = 0;
      currentIndex = fieldStartIndex + field.currentValue.length;
      for (let i = 0; i < words.length && wordCount < 5; i++) {
        if (currentIndex < 0) {
          currentIndex += words[i].length;
          continue;
        }
        if (/\w+/.test(words[i])) {
          afterWords.push(words[i]);
          wordCount++;
        }
        currentIndex += words[i].length;
      }
      
      // Store enhanced context
      field.contextBefore = beforeWords.join('');
      field.contextAfter = afterWords.join('');
      field.fullContext = `...${field.contextBefore}【${field.currentValue}】${field.contextAfter}...`;
      
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