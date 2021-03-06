/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import {IDisposable} from 'vs/base/common/lifecycle';
import {TPromise} from 'vs/base/common/winjs.base';
import {EditorModel, IEncodingSupport} from 'vs/workbench/common/editor';
import {StringEditorModel} from 'vs/workbench/common/editor/stringEditorModel';
import URI from 'vs/base/common/uri';
import {EventType, EndOfLinePreference} from 'vs/editor/common/editorCommon';
import {EventType as WorkbenchEventType, ResourceEvent} from 'vs/workbench/common/events';
import {IFilesConfiguration} from 'vs/platform/files/common/files';
import {IConfigurationService} from 'vs/platform/configuration/common/configuration';
import {IEventService} from 'vs/platform/event/common/event';
import {IModeService} from 'vs/editor/common/services/modeService';
import {IModelService} from 'vs/editor/common/services/modelService';
import {IMode} from 'vs/editor/common/modes';
import {isUnspecific} from 'vs/base/common/mime';
import Event, {Emitter} from 'vs/base/common/event';

export class UntitledEditorModel extends StringEditorModel implements IEncodingSupport {
	private textModelChangeListener: IDisposable;
	private configurationChangeListener: IDisposable;

	private dirty: boolean;
	private _onDidChangeDirty: Emitter<void>;

	private configuredEncoding: string;
	private preferredEncoding: string;

	private hasAssociatedFilePath: boolean;

	constructor(
		value: string,
		mime: string,
		resource: URI,
		hasAssociatedFilePath: boolean,
		@IModeService modeService: IModeService,
		@IModelService modelService: IModelService,
		@IEventService private eventService: IEventService,
		@IConfigurationService private configurationService: IConfigurationService
	) {
		super(value, mime, resource, modeService, modelService);

		this.hasAssociatedFilePath = hasAssociatedFilePath;
		this.dirty = hasAssociatedFilePath; // untitled associated to file path are dirty right away

		this._onDidChangeDirty = new Emitter<void>();

		this.registerListeners();
	}

	public get onDidChangeDirty(): Event<void> {
		return this._onDidChangeDirty.event;
	}

	protected getOrCreateMode(modeService: IModeService, mime: string, firstLineText?: string): TPromise<IMode> {
		if (isUnspecific(mime)) {
			return modeService.getOrCreateModeByFilenameOrFirstLine(this.resource.fsPath, firstLineText); // lookup mode via resource path if the provided mime is unspecific
		}

		return super.getOrCreateMode(modeService, mime, firstLineText);
	}

	private registerListeners(): void {

		// Config Changes
		this.configurationChangeListener = this.configurationService.onDidUpdateConfiguration(e => this.onConfigurationChange(e.config));
	}

	private onConfigurationChange(configuration: IFilesConfiguration): void {
		this.configuredEncoding = configuration && configuration.files && configuration.files.encoding;
	}

	public getValue(): string {
		if (this.textEditorModel) {
			return this.textEditorModel.getValue(EndOfLinePreference.TextDefined, true /* Preserve BOM */);
		}

		return null;
	}

	public getModeId(): string {
		if (this.textEditorModel) {
			return this.textEditorModel.getModeId();
		}

		return null;
	}

	public getEncoding(): string {
		return this.preferredEncoding || this.configuredEncoding;
	}

	public setEncoding(encoding: string): void {
		const oldEncoding = this.getEncoding();
		this.preferredEncoding = encoding;

		// Emit if it changed
		if (oldEncoding !== this.preferredEncoding) {
			this.eventService.emit(WorkbenchEventType.RESOURCE_ENCODING_CHANGED, new ResourceEvent(this.resource));
		}
	}

	public isDirty(): boolean {
		return this.dirty;
	}

	public revert(): void {
		this.dirty = false;

		this._onDidChangeDirty.fire();
	}

	public load(): TPromise<EditorModel> {
		return super.load().then((model) => {
			const configuration = this.configurationService.getConfiguration<IFilesConfiguration>();

			// Encoding
			this.configuredEncoding = configuration && configuration.files && configuration.files.encoding;

			// Listen to content changes
			this.textModelChangeListener = this.textEditorModel.onDidChangeContent(e => this.onModelContentChanged());

			// Emit initial dirty event if we are
			if (this.dirty) {
				setTimeout(() => {
					this._onDidChangeDirty.fire();
				}, 0 /* prevent race condition between creating model and emitting dirty event */);
			}

			return model;
		});
	}

	private onModelContentChanged(): void {

		// turn dirty if we were not
		if (!this.dirty) {
			this.dirty = true;
			this._onDidChangeDirty.fire();
		}

		// mark the untitled editor as non-dirty once its content becomes empty and we do
		// not have an associated path set
		else if (!this.hasAssociatedFilePath && this.textEditorModel.getLineCount() === 1 && this.textEditorModel.getLineContent(1) === '') {
			this.dirty = false;
			this._onDidChangeDirty.fire();
		}
	}

	public dispose(): void {
		super.dispose();

		if (this.textModelChangeListener) {
			this.textModelChangeListener.dispose();
			this.textModelChangeListener = null;
		}

		if (this.configurationChangeListener) {
			this.configurationChangeListener.dispose();
			this.configurationChangeListener = null;
		}
	}
}