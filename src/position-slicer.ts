
// Contains the class and some functions that are used to track positions in a document
// and display their slices

import * as vscode from 'vscode'
import { getFlowrSession } from './extension'
import { makeUri, getReconstructionContentProvider, showUri } from './doc-provider'
import { getPositionAt } from './flowr/utils'
import type { DecoTypes } from './slice'
import { displaySlice, makeSliceDecorationTypes } from './slice'
import { getSelectionSlicer } from './selection-slicer'

const positionSlicerAuthority = 'doc-slicer'
const positionSlicerSuffix = 'Slice'

// A map of all active position slicers
// Slicers are removed when they have no more tracked positions
export const docSlicers: Map<vscode.TextDocument, PositionSlicer> = new Map()


// Add the current cursor position(s) in the active editor to the list of slice criteria
export async function addCurrentPositions(): Promise<void> {
	const editor = vscode.window.activeTextEditor
	if(!editor){
		return
	}
	const positions = editor.selections.map(sel => sel.start)
	await addPositions(positions, editor.document)
}


// Get the position slicer for the active doc, if any
export function getActivePositionSlicer(): PositionSlicer | undefined {
	const editor = vscode.window.activeTextEditor
	if(!editor){
		return undefined
	}
	const doc = editor.document
	return docSlicers.get(doc)
}
// If the active document has a position slicer, dispose it and return true, else false
export function disposeActivePositionSlicer(): boolean {
	const slicer = getActivePositionSlicer()
	if(!slicer){
		return false
	}
	slicer.dispose()
	docSlicers.delete(slicer.doc)
	return true
}


// Add a list of positions in a document to the slice criteria
export async function addPositions(positions: vscode.Position[], doc: vscode.TextDocument): Promise<PositionSlicer | undefined> {
	// Get or create a slicer for the document
	const flowrSlicer = docSlicers.get(doc) || new PositionSlicer(doc)
	if(!docSlicers.has(doc)){
		docSlicers.set(doc, flowrSlicer)
	}
	
	// Try to toggle the indicated positions
	const ret = flowrSlicer.togglePositions(positions)
	if(ret){
		// Update the output if any positions were toggled
		await flowrSlicer.updateOutput()
	}

	if(flowrSlicer.offsets.length === 0){
		// Dispose the slicer if no positions are sliced (anymore)
		flowrSlicer.dispose()
		docSlicers.delete(doc)
		return undefined
	} else {
		// If the slicer is active, make sure there are no selection-slice decorations in its editors
		getSelectionSlicer().clearSliceDecos(undefined, doc)
	}
	return flowrSlicer
}

export class PositionSlicer {
	listeners: ((e: vscode.Uri) => unknown)[] = []

	doc: vscode.TextDocument

	offsets: number[] = []

	sliceDecos: DecoTypes | undefined = undefined

	positionDeco: vscode.TextEditorDecorationType

	constructor(doc: vscode.TextDocument){
		this.doc = doc
		
		this.positionDeco = makeSliceDecorationTypes().slicedPos
		
		vscode.workspace.onDidChangeTextDocument(async(e) => {
			await this.onDocChange(e)
		})
	}

	dispose(): void {
		// Clear the content provider, decorations and tracked positions
		const provider = getReconstructionContentProvider()
		const uri = makeUri(positionSlicerAuthority, positionSlicerSuffix)
		provider.updateContents(uri, undefined)
		this.positionDeco?.dispose()
		this.sliceDecos?.dispose()
	}
	
	togglePositions(positions: vscode.Position[]): boolean {
		// convert positions to offsets
		let offsets = positions.map(pos => this.normalizeOffset(pos))
		offsets = offsets.filter(i => i >= 0)

		// return early if no valid offsets
		if(offsets.length === 0){
			return false
		}

		// add offsets that are not yet tracked
		let onlyRemove = true
		for(const offset of offsets){
			const idx = this.offsets.indexOf(offset)
			if(idx < 0){
				this.offsets.push(offset)
				onlyRemove = false
			}
		}

		// if all offsets are already tracked, toggle them off
		if(onlyRemove){
			this.offsets = this.offsets.filter(offset => !offsets.includes(offset))
		}

		return true
	}

	async showReconstruction(): Promise<vscode.TextEditor> {
		const uri = this.makeUri()
		return showUri(uri)
	}

	async updateOutput(): Promise<void> {
		const provider = getReconstructionContentProvider()
		this.updateTargetDecos()
		const code = await this.updateSlices() || '# No slice'
		const uri = this.makeUri()
		provider.updateContents(uri, code)
	}

	makeUri(): vscode.Uri {
		const docPath = this.doc.uri.path + ` - ${positionSlicerSuffix}`
		return makeUri(positionSlicerAuthority, docPath)
	}

	protected async onDocChange(e: vscode.TextDocumentChangeEvent): Promise<void> {
		// Check if there are changes to the tracked document
		if(e.document !== this.doc) {
			return
		}
		if(e.contentChanges.length == 0){
			return
		}

		// Compute new offsets after the changes
		const newOffsets: number[] = [	]
		for(let offset of this.offsets) {
			for(const cc of e.contentChanges) {
				const offset1 = shiftOffset(offset, cc)
				if(!offset1){
					offset = -1
					break
				} else {
					offset = offset1
				}
			}
			offset = this.normalizeOffset(offset)
			if(offset >= 0){
				newOffsets.push(offset)
			}
		}
		this.offsets = newOffsets
		
		// Update decos and editor output
		await this.updateOutput()
	}

	protected normalizeOffset(offsetOrPos: number | vscode.Position): number {
		// Convert a position to an offset and move it to the beginning of the word
		if(typeof offsetOrPos === 'number'){
			offsetOrPos = this.doc.positionAt(offsetOrPos)
		}
		const range = getPositionAt(offsetOrPos, this.doc)
		if(!range){
			return -1
		}
		return this.doc.offsetAt(range.start)
	}

	protected updateTargetDecos(): void {
		// Update the decorations in the relevant editors
		const ranges = []
		for(const offset of this.offsets){
			const pos = this.doc.positionAt(offset)
			const range = getPositionAt(pos, this.doc)
			if(range){
				ranges.push(range)
			}
		}
		for(const editor of vscode.window.visibleTextEditors){
			if(editor.document === this.doc){
				this.sliceDecos ||= makeSliceDecorationTypes()
				editor.setDecorations(this.positionDeco, ranges)
			}
		}
	}

	protected async updateSlices(): Promise<string | undefined> {
		// Update the decos that show the slice results
		const session = await getFlowrSession()
		const positions = this.offsets.map(offset => this.doc.positionAt(offset))
		if(positions.length === 0){
			this.clearSliceDecos()
			return
		}
		const { code, sliceElements } = await session.retrieveSlice(positions, this.doc)
		if(sliceElements.length === 0){
			this.clearSliceDecos()
			return
		}
		for(const editor of vscode.window.visibleTextEditors){
			if(editor.document === this.doc) {
				this.sliceDecos ||= makeSliceDecorationTypes()
				void displaySlice(editor, sliceElements, this.sliceDecos)
			}
		}
		return code
	}

	protected clearSliceDecos(): void {
		this.sliceDecos?.dispose()
		this.sliceDecos = undefined
	}
}

function shiftOffset(offset: number, cc: vscode.TextDocumentContentChangeEvent): number | undefined {
	if(cc.rangeOffset > offset){
		// pos is before range -> no change
		return offset
	}
	if(cc.rangeLength + cc.rangeOffset > offset){
		// pos is inside range -> invalidate pos
		return undefined
	}
	// pos is after range -> adjust pos
	const offsetDelta = cc.text.length - cc.rangeLength
	const offset1 = offset + offsetDelta
	return offset1
}