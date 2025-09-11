import * as vscode from 'vscode';
import * as path from 'path';
import { getCodeSummary, getSummaryWithReference, getCodeFromSummaryEdit, getCodeFromDirectInstruction, getSummaryFromInstruction, buildSummaryMapping } from '../llm/llmApi';
import { getLastActiveEditor } from '../extension';
import * as fs from 'fs';
import * as os from 'os';
import { v4 as uuidv4 } from 'uuid';
import DiffMatchPatch from 'diff-match-patch';
import { logInteractionFromFrontend } from '../utils/telemetry';

// Color palette for summary-code mapping highlights (must match frontend)
const SUMMARY_CODE_MAPPING_COLORS = [
    "#FFB3C6", // pink
    "#B9FBC0", // green
    "#FFD6A5", // orange
    "#D0BFFF", // purple
    "#A3D3FF", // blue
    "#FFDAC1", // peach
    "#FFFACD", // yellow
    "#E0BBE4", // lavender
    "#FEC8D8", // pastel rose
    "#C7CEEA", // periwinkle
    "#B5EAD7", // mint
];

// Constants for code matching
const BITAP_LIMIT = 32;
const MIN_MATCH_SCORE = 0.9;

// Structured state for the current highlight to avoid races and attach lifecycle disposables
let currentHighlight: {
    id: string;
    decoration: vscode.TextEditorDecorationType;
    editor: vscode.TextEditor;
    disposables: vscode.Disposable[];
} | null = null;

/**
 * Map to track temp file associations for diff/accept/reject workflow.
 * Key: original file path, Value: { tempFilePath: string, range: vscode.Range }
 */
const diffStateMap: Map<string, { tempFilePath: string }> = new Map();

/**
 * Interface for match result
 */
interface MatchResult {
    location: number;
    score?: number;
}

/**
 * Finds the best match for a pattern in text using multiple matching strategies
 * @param text The text to search in
 * @param pattern The pattern to search for
 * @param offset Starting offset for search
 * @param options Matching options
 * @returns MatchResult with location and optional score
 */
function findBestMatch(
    text: string,
    pattern: string,
    offset: number = 0,
    options: {
        caseSensitive?: boolean;
        useFuzzyMatch?: boolean;
        bitapLimit?: number;
        minScore?: number;
    } = {}
): MatchResult {
    const {
        caseSensitive = false,
        useFuzzyMatch = true,
        bitapLimit = BITAP_LIMIT,
        minScore = MIN_MATCH_SCORE
    } = options;

    // 1. Try exact match
    let location = text.indexOf(pattern, offset);
    if (location !== -1) {
        return { location };
    }

    // 2. Try case-insensitive match
    if (!caseSensitive) {
        location = text.toLowerCase().indexOf(pattern.toLowerCase(), offset);
        if (location !== -1) {
            return { location };
        }
    }

    // 3. Try fuzzy match if enabled and pattern is short enough
    if (useFuzzyMatch && pattern.length <= bitapLimit) {
        try {
            const dmp = new DiffMatchPatch();
            location = dmp.match_main(text, pattern, offset);
            if (location !== -1) {
                return { location };
            }
        } catch (e) {
            // Ignore Bitap errors
        }
    }

    // 4. Try sliding window fuzzy match for long patterns
    if (useFuzzyMatch && pattern.length > bitapLimit) {
        let bestScore = 0;
        let bestLocation = -1;
        const dmp = new DiffMatchPatch();

        for (let i = 0; i <= text.length - bitapLimit; i++) {
            const window = text.substr(i, bitapLimit);
            let score = 0;
            try {
                const diffs = dmp.diff_main(window, pattern.substr(0, bitapLimit));
                dmp.diff_cleanupSemantic(diffs);
                let editDistance = 0;
                diffs.forEach((d: [number, string]) => {
                    if (d[0] !== 0) { editDistance += d[1].length; }
                });
                score = (bitapLimit - editDistance) / bitapLimit;
                if (score > bestScore) {
                    bestScore = score;
                    bestLocation = i;
                }
            } catch (e) {
                // Ignore errors
            }
        }

        if (bestScore >= minScore) {
            return { location: bestLocation, score: bestScore };
        }
    }

    return { location: -1 };
}

/**
 * Interface for patch result
 */
interface PatchResult {
    success: boolean;
    patchedText?: string;
    error?: string;
}

/**
 * Applies a patch to the original text
 * @param originalText The original text
 * @param newText The new text to apply
 * @param options Patch options
 * @returns PatchResult with success status and patched text
 */
function applyPatch(
    originalText: string,
    newText: string,
    options: {
        preserveIndentation?: boolean;
    } = {}
): PatchResult {
    const { preserveIndentation = true } = options;

    try {
        // Preserve indentation if needed
        if (preserveIndentation) {
            const originalFirstLineIndent = (originalText.match(/^[ \t]*/)?.[0]) || '';
            if (originalFirstLineIndent && !/^[ \t]/.test(newText.split(/\r?\n/)[0])) {
                newText = originalFirstLineIndent + newText;
            }
        }

        const dmp = new DiffMatchPatch();
        const patchList = dmp.patch_make(originalText, newText);
        const [patchedText, results] = dmp.patch_apply(patchList, originalText);

        if (results.some((applied: boolean) => !applied)) {
            return {
                success: false,
                error: "Failed to apply patch. The code may have changed too much."
            };
        }

        return { success: true, patchedText };
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : "An unexpected error occurred while applying changes."
        };
    }
}

export async function handleMessage(
    message: any,
    webviewContainer: vscode.WebviewPanel | vscode.WebviewView
) {
    switch (message.command) {
        case 'getSummary':
            await handleGetSummary(message, webviewContainer);
            break;
        case 'summaryPrompt':
            await handleSummaryPrompt(message, webviewContainer);
            break;
        case 'directPrompt':
            await handleDirectPrompt(message, webviewContainer);
            break;
        case 'promptToSummary':
            await handlePromptToSummary(message, webviewContainer);
            break;
        case 'highlightCodeMapping':
            await handleHighlightCodeMapping(message);
            break;
        case 'clearHighlight':
            await handleClearHighlight();
            break;
        case 'checkSectionValidity':
            await handleCheckSectionValidity(message, webviewContainer);
            break;
        case 'interactionLog':
            await logInteractionFromFrontend({
                timestamp: message.timestamp,
                source: message.source,
                event: message.event,
                data: message.data
            });
            break;
    }
}

/**
 * Handles the highlightCodeMapping command from the webview.
 * Finds the code snippet in the open editor and applies a highlight decoration.
 * @param message The message containing codeSnippet, filename/fullPath, colorIndex
 */
async function handleHighlightCodeMapping(message: any) {
    await handleClearHighlight();

    const editor = getLastActiveEditor();
    if (!editor) {
        console.warn("[highlightCodeMapping] No active editor found.");
        return;
    }

    const { selectedCode, codeSegments, colorIndex, filename, fullPath } = message;

    if (typeof selectedCode !== "string" || typeof colorIndex !== "number") {
        console.warn("[highlightCodeMapping] Invalid selectedCode or colorIndex.");
        return;
    }

    const editorPath = editor.document.fileName;
    if (fullPath && editorPath !== fullPath) {
        return;
    }

    const docText = editor.document.getText();

    const regionMatch = findBestMatch(docText, selectedCode);
    if (regionMatch.location === -1) {
        console.warn("[highlightCodeMapping] Could not find selectedCode region in file.");
        return;
    }

    const allRanges: vscode.Range[] = [];

    if (Array.isArray(codeSegments) && codeSegments.length > 0) {
        const filteredSegments = codeSegments.filter(
            seg => seg && typeof seg.line === "number" && seg.line > 0
        );
        for (const seg of filteredSegments) {
            const lineNum = seg.line - 1;
            if (lineNum < 0 || lineNum >= editor.document.lineCount) { continue; }
            const lineText = editor.document.lineAt(lineNum).text;
            let startChar = 0;
            let endChar = lineText.length;
            if (typeof seg.code === "string" && seg.code.trim().length > 0) {
                const idx = lineText.indexOf(seg.code);
                if (idx !== -1) {
                    startChar = idx;
                    endChar = idx + seg.code.length;
                }
            }
            const start = new vscode.Position(lineNum, startChar);
            const end = new vscode.Position(lineNum, endChar);
            allRanges.push(new vscode.Range(start, end));
        }
    }

    if (allRanges.length > 0) {
        const color = SUMMARY_CODE_MAPPING_COLORS[colorIndex % SUMMARY_CODE_MAPPING_COLORS.length] + "80";
        const decorationType = vscode.window.createTextEditorDecorationType({
            backgroundColor: color,
            isWholeLine: false,
            borderRadius: "3px"
        });

        editor.setDecorations(decorationType, allRanges);
        // create a new highlight record with lifecycle disposables
        const highlightId = uuidv4();
        const disposables: vscode.Disposable[] = [];
        disposables.push(vscode.workspace.onDidChangeTextDocument((e) => {
            if (e.document.fileName === editor.document.fileName) {
                void handleClearHighlight(highlightId);
            }
        }));
        disposables.push(vscode.workspace.onDidCloseTextDocument((doc) => {
            if (doc.fileName === editor.document.fileName) {
                void handleClearHighlight(highlightId);
            }
        }));
        disposables.push(vscode.window.onDidChangeActiveTextEditor((active) => {
            if (!active || active.document.fileName !== editor.document.fileName) {
                void handleClearHighlight(highlightId);
            }
        }));
        currentHighlight = { id: highlightId, decoration: decorationType, editor, disposables };
    } else {
        console.warn("[highlightCodeMapping] No code regions found to highlight.");
    }
}

/**
 * Handles the clearHighlight command from the webview.
 * Removes any existing highlight decoration from the editor.
 */
async function handleClearHighlight(id?: string) {
    if (!currentHighlight) { return; }
    if (id && currentHighlight.id !== id) { return; }

    try {
        try {
            currentHighlight.editor.setDecorations(currentHighlight.decoration, []);
        } catch (e) {
            // ignore setDecorations errors
        }
        try {
            currentHighlight.decoration.dispose();
        } catch (e) {
            // ignore dispose errors
        }
        for (const d of currentHighlight.disposables) {
            try { d.dispose(); } catch { }
        }
    } finally {
        currentHighlight = null;
    }
}

/**
 * Generates file context including file name, path and content
 * @param filePath The full path of the file
 * @returns Formatted file context string
 */
async function generateFileContext(filePath: string): Promise<string> {
    try {
        const filename = path.basename(filePath);
        const fileContent = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
        return `File: ${filename}\nPath: ${filePath}\n\nFile Content:\n${fileContent.toString()}`;
    } catch (error) {
        console.error('Error reading file for context:', error);
        return `File: ${path.basename(filePath)}\nPath: ${filePath}\n\nFile Content:\n[Error reading file]`;
    }
}

/**
 * Handles the getSummary command.
 */
async function handleGetSummary(
    message: any,
    webviewContainer: vscode.WebviewPanel | vscode.WebviewView
) {
    // If present, use oldSummaryData from the message (for post-edit summary workflow)
    const oldSummaryData = message.oldSummaryData || undefined;
    // Use newCode from message if present, otherwise use current selection
    const editor = getLastActiveEditor();
    const selectedText = message.newCode || (editor?.document.getText(editor.selection) || '');

    if (!selectedText) {
        webviewContainer.webview.postMessage({
            command: 'summaryResult',
            error: 'No code selected.'
        });
        return;
    }

    try {
        // Stage 1: Generating summary
        webviewContainer.webview.postMessage({
            command: 'summaryProgress',
            stage: 1,
            stageText: 'Generating summary...'
        });
        const filePath = editor?.document.fileName || '';
        const fileContext = await generateFileContext(filePath);

        // Use getSummaryWithReference if oldSummaryData is present, otherwise use getCodeSummary
        let summary;
        if (
            oldSummaryData &&
            oldSummaryData.title &&
            typeof oldSummaryData.low_unstructured === "string" &&
            typeof oldSummaryData.low_structured === "string" &&
            typeof oldSummaryData.medium_unstructured === "string" &&
            typeof oldSummaryData.medium_structured === "string" &&
            typeof oldSummaryData.high_unstructured === "string" &&
            typeof oldSummaryData.high_structured === "string"
        ) {
            // Use originalCode from oldSummaryData context if available, else fallback to selectedText
            const originalCode = oldSummaryData.originalCode || selectedText;
            summary = await getSummaryWithReference(selectedText, originalCode, oldSummaryData, fileContext);
        } else {
            summary = await getCodeSummary(selectedText, fileContext);
        }

        const filename = editor ? path.basename(editor.document.fileName) : '';
        const fullPath = editor?.document.fileName || '';

        // Determine lines and offset based on whether newCode is used
        let lines = '';
        let offset = 0;
        if (message.newCode && editor) {
            // If newCode is present, find its position in the file and use that for lines and offset
            const docText = editor.document.getText();
            const match = findBestMatch(docText, message.newCode);
            if (match.location !== -1) {
                const startPos = editor.document.positionAt(match.location);
                const endPos = editor.document.positionAt(match.location + message.newCode.length);
                lines = `${startPos.line + 1}-${endPos.line + 1}`;
                offset = match.location;
            } else {
                // Fallback to selection if not found
                lines = `${editor.selection.start.line + 1}-${editor.selection.end.line + 1}`;
                offset = editor.document.offsetAt(editor.selection.start);
            }
        } else if (editor) {
            // Use the editor selection as before
            lines = `${editor.selection.start.line + 1}-${editor.selection.end.line + 1}`;
            offset = editor.document.offsetAt(editor.selection.start);
        }

        // Stage 2+: Build mapping for all 6 summary types (concurrent)
        const mappingKeys = [
            ["low", "unstructured"],
            ["low", "structured"],
            ["medium", "unstructured"],
            ["medium", "structured"],
            ["high", "unstructured"],
            ["high", "structured"]
        ] as const;

        // Only report progress once before all mappings
        webviewContainer.webview.postMessage({
            command: 'summaryProgress',
            stageText: 'Mapping all summaries...'
        });

        // Compute real start line (1-based) for mapping anchor
        let realStartLine = 1;
        if (editor) {
            const docText = editor.document.getText();
            const match = findBestMatch(docText, selectedText);
            if (match.location !== -1) {
                const startPos = editor.document.positionAt(match.location);
                realStartLine = startPos.line + 1;
            } else {
                realStartLine = editor.selection.start.line + 1;
            }
        }

        // Run all mappings concurrently, pass realStartLine to buildSummaryMapping
        const mappingPromises = mappingKeys.map(([detail, structured]) => {
            const key = `${detail}_${structured}` as keyof typeof summary;
            const summaryText = (summary as any)[key] || "";
            return buildSummaryMapping(selectedText, summaryText, realStartLine);
        });
        const mappingResults = await Promise.all(mappingPromises);

        // Assemble summaryMappings object
        const summaryMappings: Record<string, any[]> = {};
        mappingKeys.forEach(([detail, structured], idx) => {
            const key = `${detail}_${structured}` as keyof typeof summary;
            summaryMappings[key] = mappingResults[idx];
        });

        // Final result: send summaryResult to frontend
        webviewContainer.webview.postMessage({
            command: 'summaryResult',
            data: summary,
            filename,
            fullPath,
            lines,
            title: summary.title,
            createdAt: new Date().toLocaleString(),
            originalCode: selectedText,
            offset,
            summaryMappings,
            ...(oldSummaryData ? { oldSummaryData } : {})
        });
    } catch (err: any) {
        webviewContainer.webview.postMessage({
            command: 'summaryResult',
            error: 'Failed to get summary from LLM: ' + (err?.message || err)
        });
    }
}

/**
 * Handles the promptToSummary command.
 * This operation only updates the summary using the LLM and does not require a code selection.
 */
async function handlePromptToSummary(
    message: any,
    webviewContainer: vscode.WebviewPanel | vscode.WebviewView
) {
    // Call the LLM to update the summary based on the direct prompt
    const updatedSummary = await getSummaryFromInstruction(
        message.originalCode,
        message.originalSummary,
        message.promptText
    );

    // Return the updated summary to the frontend
    webviewContainer.webview.postMessage({
        command: 'editResult',
        sectionId: message.sectionId,
        action: 'promptToSummary',
        newCode: updatedSummary
    });
}

/**
 * Handles the summaryPrompt command with fuzzy patching.
 */
async function handleSummaryPrompt(
    message: any,
    webviewContainer: vscode.WebviewPanel | vscode.WebviewView
) {
    const { originalCode, filename, fullPath } = message;
    if (!originalCode || !(filename || fullPath)) {
        webviewContainer.webview.postMessage({
            command: 'editResult',
            sectionId: message.sectionId,
            action: 'summaryPrompt',
            error: 'Missing original code or filename.'
        });
        return;
    }

    const filePath = fullPath || path.join(vscode.workspace.rootPath || '', filename);
    const fileContext = await generateFileContext(filePath);
    const newCode = await getCodeFromSummaryEdit(
        originalCode,
        message.summaryText,
        message.detailLevel,
        message.structuredType,
        fileContext,
        message.originalSummary
    );

    await applyCodeChanges(webviewContainer, message, originalCode, newCode, filename, fullPath, 'summaryPrompt');
}

/**
 * Handles the directPrompt command with fuzzy patching.
 */
async function handleDirectPrompt(
    message: any,
    webviewContainer: vscode.WebviewPanel | vscode.WebviewView
) {
    const { originalCode, filename, fullPath } = message;
    if (!originalCode || !(filename || fullPath)) {
        webviewContainer.webview.postMessage({
            command: 'editResult',
            sectionId: message.sectionId,
            action: 'directPrompt',
            error: 'Missing original code or filename.'
        });
        return;
    }

    const filePath = fullPath || path.join(vscode.workspace.rootPath || '', filename);
    const fileContext = await generateFileContext(filePath);
    const newCode = await getCodeFromDirectInstruction(originalCode, message.promptText, fileContext);
    await applyCodeChanges(webviewContainer, message, originalCode, newCode, filename, fullPath, 'directPrompt');
}

/**
 * Applies a fuzzy patch to the file, replacing the matched region with new code.
 * This function is used by both directPrompt and editSummaryPrompt handlers.
 * Returns { success: boolean, patchedText?: string, error?: string }
 */
async function applyFuzzyPatchAndReplaceInFile(
    fileUri: vscode.Uri,
    document: vscode.TextDocument,
    originalCode: string,
    newCode: string,
    offset: number
): Promise<{ success: boolean; patchedText?: string; error?: string }> {
    try {
        const fileText = document.getText();

        // Find the location of the original code in the file
        const match = findBestMatch(fileText, originalCode, offset);
        if (match.location === -1) {
            return { success: false, error: "Could not find the original code in the file. The code may have changed too much." };
        }

        // Apply the patch
        const patchResult = applyPatch(originalCode, newCode);
        if (!patchResult.success) {
            return patchResult;
        }

        const edit = new vscode.WorkspaceEdit();
        const start = document.positionAt(match.location);
        const end = document.positionAt(match.location + originalCode.length);
        edit.replace(fileUri, new vscode.Range(start, end), patchResult.patchedText!);

        const success = await vscode.workspace.applyEdit(edit);
        if (!success) {
            return { success: false, error: "Failed to apply edit to the file." };
        }

        return { success: true, patchedText: patchResult.patchedText };
    } catch (error) {
        console.error('Error applying patch:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : "An unexpected error occurred while applying changes."
        };
    }
}

/**
 * Opens a file and returns its document and URI
 * @param filename The filename to open
 * @param fullPath The full path to the file
 * @returns Object containing the document and URI, or null if file cannot be opened
 */
async function openFile(filename: string, fullPath: string): Promise<{ document: vscode.TextDocument; fileUri: vscode.Uri } | null> {
    const fileUri = fullPath
        ? vscode.Uri.file(fullPath)
        : vscode.Uri.file(path.isAbsolute(filename) ? filename : path.join(vscode.workspace.rootPath || "", filename));

    try {
        // Check if file exists before opening
        let fileExists = true;
        try {
            await vscode.workspace.fs.stat(fileUri);
        } catch (e) {
            fileExists = false;
        }
        if (!fileExists) {
            return null;
        }
        const document = await vscode.workspace.openTextDocument(fileUri);
        return { document, fileUri };
    } catch (err) {
        return null;
    }
}

/**
 * Common function to apply code changes to a file.
 * Accepts either a WebviewPanel or WebviewView as the webview container.
 * @param webviewContainer The webview panel or view instance
 * @param message The original message
 * @param originalCode The original code to be replaced
 * @param newCode The new code to replace with
 * @param filename The filename
 * @param fullPath The full path to the file
 * @param action The action type (directPrompt or editSummaryPrompt)
 */
async function applyCodeChanges(
    webviewContainer: vscode.WebviewPanel | vscode.WebviewView,
    message: any,
    originalCode: string,
    newCode: string,
    filename: string,
    fullPath: string,
    action: 'directPrompt' | 'summaryPrompt'
) {
    try {
        const fileInfo = await openFile(filename, fullPath);
        if (!fileInfo) {
            webviewContainer.webview.postMessage({
                command: 'editResult',
                sectionId: message.sectionId,
                action,
                error: `File not found: ${filename}. Please check that the file exists in your workspace.`
            });
            return;
        }

        const { document, fileUri } = fileInfo;
        const offset = typeof message.offset === "number" ? message.offset : 0;

        // --- Save original code to a temp file before patching ---
        // Generate a unique temp file path
        const tempFilePath = path.join(os.tmpdir(), `naturaledit_${uuidv4()}_${filename}`);
        // Write the original code to the temp file
        fs.writeFileSync(tempFilePath, document.getText(), 'utf8');

        // Track the temp file for this file
        diffStateMap.set(fileUri.fsPath, { tempFilePath });

        // --- Apply the patch ---
        const result = await applyFuzzyPatchAndReplaceInFile(fileUri, document, originalCode, newCode, offset);

        if (!result.success) {
            webviewContainer.webview.postMessage({
                command: 'editResult',
                sectionId: message.sectionId,
                action,
                error: result.error
            });
            // Clean up temp file if patch failed
            try { fs.unlinkSync(tempFilePath); } catch { }
            diffStateMap.delete(fileUri.fsPath);
            return;
        }

        // --- Open the diff view between temp file (original) and modified file ---
        const tempFileUri = vscode.Uri.file(tempFilePath);
        await vscode.commands.executeCommand(
            'vscode.diff',
            tempFileUri,
            fileUri,
            `Review Edits: ${filename}`
        );

        // Optionally, focus the diff editor (VSCode will usually do this automatically)

        // --- After patch, notify frontend with the new code ---
        const patchedText = result.patchedText || "";
        webviewContainer.webview.postMessage({
            command: 'editResult',
            sectionId: message.sectionId,
            action,
            newCode: patchedText
        });
    } catch (error) {
        console.error('Error applying code changes:', error);
        webviewContainer.webview.postMessage({
            command: 'editResult',
            sectionId: message.sectionId,
            action,
            error: error instanceof Error ? error.message : "An unexpected error occurred."
        });
    }
}

/**
 * Handles the checkSectionValidity command.
 * Checks if the file exists and if the original code can be matched.
 * If matched, opens the file and navigates to the match.
 * @param message The message containing fullPath and originalCode
 * @param webviewContainer The webview panel or view instance
 */
async function handleCheckSectionValidity(
    message: any,
    webviewContainer: vscode.WebviewPanel | vscode.WebviewView
) {
    const { fullPath, originalCode } = message;
    if (!fullPath || !originalCode) {
        webviewContainer.webview.postMessage({
            command: 'sectionValidityResult',
            status: 'file_missing'
        });
        return;
    }

    // Try to open the file
    const fileInfo = await openFile("", fullPath);
    if (!fileInfo) {
        webviewContainer.webview.postMessage({
            command: 'sectionValidityResult',
            status: 'file_missing'
        });
        return;
    }

    const { document } = fileInfo;
    const fileText = document.getText();

    // Try to find the best match for the original code
    const match = findBestMatch(fileText, originalCode, 0);
    if (match.location === -1) {
        webviewContainer.webview.postMessage({
            command: 'sectionValidityResult',
            status: 'code_not_matched'
        });
        return;
    }

    // If matched, open the file and navigate to the match location
    try {
        const editor = await vscode.window.showTextDocument(document, { preview: false });
        const start = document.positionAt(match.location);
        const end = document.positionAt(match.location + originalCode.length);
        editor.selection = new vscode.Selection(start, end);
        editor.revealRange(new vscode.Range(start, end), vscode.TextEditorRevealType.InCenter);
    } catch (e) {
        // Ignore navigation errors, still report success
    }

    webviewContainer.webview.postMessage({
        command: 'sectionValidityResult',
        status: 'success'
    });
}
