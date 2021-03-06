/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import {Action} from 'vs/base/common/actions';
import * as strings from 'vs/base/common/strings';
import {TPromise} from 'vs/base/common/winjs.base';
import {Behaviour, IEnablementState, createActionEnablement} from 'vs/editor/common/editorActionEnablement';
import {IActionDescriptor, IActionEnablement, ICommonCodeEditor, IEditorActionDescriptorData, IEditorContribution} from 'vs/editor/common/editorCommon';
import {ILineContext} from 'vs/editor/common/modes';
import {IInstantiationService} from 'vs/platform/instantiation/common/instantiation';
import {EditorAction2} from 'vs/editor/common/editorCommonExtensions';

var defaultBehaviour = Behaviour.TextFocus | Behaviour.Writeable | Behaviour.UpdateOnModelChange;

export class EditorAction extends Action implements IEditorContribution {

	public editor:ICommonCodeEditor;

	private _supportsReadonly:boolean;
	private _descriptor:IEditorActionDescriptorData;
	private _enablementState:IEnablementState;

	constructor(descriptor:IEditorActionDescriptorData, editor:ICommonCodeEditor, condition:Behaviour = defaultBehaviour) {
		super(descriptor.id);
		this.editor = editor;
		this._descriptor = descriptor;
		this.label = descriptor.label || '';
		this._enablementState = createActionEnablement(editor, condition, this);

		this._supportsReadonly = !(condition & Behaviour.Writeable);
	}

	public getId(): string {
		return this.id;
	}

	public dispose(): void {
		this._enablementState.dispose();
		super.dispose();
	}

	public getDescriptor(): IEditorActionDescriptorData {
		return this._descriptor;
	}

	// ---- enablement state mangament --------------------------------------------------------

	public get enabled():boolean {
		return this._enablementState.value();
	}

	public set enabled(value:boolean) {
		// call reset?
		var e:any = new Error();
		console.log('setting EditorAction.enabled is UNCOOL. Use resetEnablementState and getEnablementState');
		console.log(e.stack);
	}

	public resetEnablementState():void {
		this._enablementState.reset();
	}

	/**
	 * Returns {{true}} in case this action works
	 * with the current mode. To be overwritten
	 * in subclasses.
	 */
	public isSupported():boolean {
		if (!this._supportsReadonly) {
			if (this.editor.getConfiguration().readOnly) {
				return false; // action requires a writeable model
			}

			var model = this.editor.getModel();
			if (model && model.hasEditableRange()) {
				return false; // editable ranges are an indicator for mostly readonly models
			}
		}

		return true;
	}

	/**
	 * Returns the enablement state of this action. This
	 * method is being called in the process of {{updateEnablementState}}
	 * and overwriters should call super (this method).
	 */
	public getEnablementState(): boolean {
		return true;
	}

	public getAlias(): string {
		return this._descriptor.alias;
	}
}

export class NewEditorAction extends EditorAction {

	private _actual: EditorAction2;
	private _instantiationService:IInstantiationService;

	constructor(actual:EditorAction2, editor:ICommonCodeEditor, instantiationService:IInstantiationService) {
		super({ id: actual.id, label: actual.label, alias: actual.alias }, editor, 0);
		this._actual = actual;
		this._instantiationService = instantiationService;
	}

	public get enabled():boolean {
		return this._instantiationService.invokeFunction((accessor) => {
			return this._actual.enabled(accessor, this.editor);
		});
	}

	public isSupported():boolean {
		return this._instantiationService.invokeFunction((accessor) => {
			return this._actual.supported(accessor, this.editor);
		});
	}

	public run(): TPromise<void> {
		return this._instantiationService.invokeFunction((accessor) => {
			this._actual.run(accessor, this.editor);
			return TPromise.as(void 0);
		});
	}
}

export class HandlerEditorAction extends EditorAction {
	private _handlerId: string;

	constructor(descriptor:IEditorActionDescriptorData, editor:ICommonCodeEditor, handlerId: string) {
		super(descriptor, editor);
		this._handlerId = handlerId;
	}

	public run(): TPromise<boolean> {
		this.editor.trigger(this.getId(), this._handlerId, null);
		return TPromise.as(true);
	}
}

export class DynamicEditorAction extends EditorAction {

	private static _transformBehaviour(behaviour:IActionEnablement): Behaviour {
		var r = 0;
		if (behaviour.textFocus) {
			// Allowed to set text focus only if not appearing in the context menu
			r |= Behaviour.TextFocus;
		}
		if (behaviour.widgetFocus) {
			r |= Behaviour.WidgetFocus;
		}
		if (behaviour.writeableEditor) {
			r |= Behaviour.Writeable;
		}

		if (typeof behaviour.tokensAtPosition !== 'undefined') {
			r |= Behaviour.UpdateOnCursorPositionChange;
		}
		if (typeof behaviour.wordAtPosition !== 'undefined') {
			r |= Behaviour.UpdateOnCursorPositionChange;
		}
		return r;
	}

	private _run: (editor:ICommonCodeEditor)=>void;
	private _tokensAtPosition:string[];
	private _wordAtPosition:boolean;

	constructor(descriptor:IActionDescriptor, editor:ICommonCodeEditor) {
		var enablement: IActionEnablement = descriptor.enablement || {};
		super({
			id: descriptor.id,
			label: descriptor.label
		}, editor, DynamicEditorAction._transformBehaviour(enablement));

		this._run = descriptor.run;

		this._tokensAtPosition = enablement.tokensAtPosition;
		this._wordAtPosition = enablement.wordAtPosition;
	}

	public run(): TPromise<void> {
		return TPromise.as(this._run(this.editor));
	}

	public getEnablementState():boolean {
		return this._getEnablementOnTokens() && this._getEnablementOnWord();
	}

	private _getEnablementOnTokens(): boolean {
		if (!this._tokensAtPosition) {
			return true;
		}

		var model = this.editor.getModel(),
			position = this.editor.getSelection().getStartPosition(),
			lineContext = model.getLineContext(position.lineNumber),
			offset = position.column - 1;

		return isToken(lineContext, offset, this._tokensAtPosition);
	}

	private _getEnablementOnWord(): boolean {
		if (!this._wordAtPosition) {
			return true;
		}

		var model = this.editor.getModel(),
			position = this.editor.getSelection().getStartPosition(),
			wordAtPosition = model.getWordAtPosition(position);

		return (!!wordAtPosition);
	}
}

function isToken(context:ILineContext, offset:number, types:string[]): boolean {

	if (context.getLineContent().length <= offset) {
		return false;
	}

	var tokenIdx = context.findIndexOfOffset(offset);
	var type = context.getTokenType(tokenIdx);

	for (var i = 0, len = types.length; i < len; i++) {
		if (types[i] === '') {
			if (type === '') {
				return true;
			}
		} else {
			if (strings.startsWith(type, types[i])) {
				return true;
			}
		}
	}

	return false;
}