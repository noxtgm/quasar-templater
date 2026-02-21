import {
	App,
	Modal,
	Notice,
	Setting,
	TFolder,
	TFile,
} from "obsidian";
import type NoteCreatorPlugin from "./main";
import type { NoteType } from "./types";
import { TextInputSuggest } from "./suggest";

const CUSTOM_TYPE_VALUE = "__custom__";

const FRONTMATTER_TYPES = [
	"text",
	"multitext",
	"number",
	"checkbox",
	"date",
	"datetime",
	"aliases",
	"tags",
] as const;

type FrontmatterType = (typeof FRONTMATTER_TYPES)[number];

const FRONTMATTER_TYPE_LABELS: Record<FrontmatterType, string> = {
	text: "Text",
	multitext: "List",
	number: "Number",
	checkbox: "Checkbox",
	date: "Date",
	datetime: "Date & time",
	aliases: "Aliases",
	tags: "Tags",
};

class ModalFolderSuggest extends TextInputSuggest<TFolder> {
	constructor(app: App, inputEl: HTMLInputElement) {
		super(app, inputEl);
	}

	getSuggestions(query: string): TFolder[] {
		const folders: TFolder[] = [];
		const lowerQuery = query.toLowerCase();
		const rootFolder = this.app.vault.getRoot();
		this.collectFolders(rootFolder, folders);
		return folders
			.filter((folder) => folder.path.toLowerCase().includes(lowerQuery))
			.slice(0, 20);
	}

	private collectFolders(folder: TFolder, result: TFolder[]): void {
		for (const child of folder.children) {
			if (child instanceof TFolder) {
				result.push(child);
				this.collectFolders(child, result);
			}
		}
	}

	renderSuggestion(folder: TFolder, el: HTMLElement): void {
		el.setText(folder.path);
	}

	selectSuggestion(folder: TFolder): void {
		this.inputEl.value = folder.path;
		this.inputEl.trigger("input");
		this.close();
	}
}

/**
 * Suggests existing frontmatter values from other notes in the vault,
 * matching Obsidian's native frontmatter autocomplete behavior.
 */
class FrontmatterValueSuggest extends TextInputSuggest<string> {
	private getKey: () => string;

	constructor(
		app: App,
		inputEl: HTMLInputElement | HTMLTextAreaElement,
		getKey: () => string
	) {
		super(app, inputEl);
		this.getKey = getKey;
	}

	getSuggestions(query: string): string[] {
		const key = this.getKey()?.trim();
		if (!key) return [];

		const seen = new Set<string>();
		const lowerQuery = query.toLowerCase();

		for (const file of this.app.vault.getMarkdownFiles()) {
			const cache = this.app.metadataCache.getFileCache(file);
			const value = cache?.frontmatter?.[key];
			if (value === undefined || value === null) continue;

			const strings: string[] = Array.isArray(value)
				? value.filter((v): v is string => typeof v === "string").map((s) => String(s).trim())
				: [String(value).trim()];

			for (const s of strings) {
				if (s && !seen.has(s) && s.toLowerCase().includes(lowerQuery)) {
					seen.add(s);
				}
			}
		}

		return Array.from(seen).sort().slice(0, 20);
	}

	renderSuggestion(value: string, el: HTMLElement): void {
		el.setText(value);
	}

	selectSuggestion(value: string): void {
		this.inputEl.value = value;
		this.inputEl.trigger("input");
		this.close();
	}
}

interface FrontmatterField {
	key: string;
	value: string;
	type: FrontmatterType;
}

interface CustomProperty {
	key: string;
	value: string;
	type: FrontmatterType;
}

type TemplaterPlugin = {
	templater: {
		create_new_note_from_template: (
			template: TFile,
			folder: TFolder,
			filename: string,
			openNew: boolean
		) => Promise<TFile | undefined>;
	};
};

export class NoteCreatorModal extends Modal {
	private plugin: NoteCreatorPlugin;
	private noteName = "";
	private selectedTypeId = "";
	private frontmatterFields: FrontmatterField[] = [];
	private customProperties: CustomProperty[] = [];
	private customDestinationFolder = "";
	private fieldsContainer: HTMLElement | null = null;
	private actionsContainer: HTMLElement | null = null;
	private refreshCustomProperties: (() => void) | null = null;

	constructor(app: App, plugin: NoteCreatorPlugin) {
		super(app);
		this.plugin = plugin;
	}

	private getTemplaterPlugin(): TemplaterPlugin | null {
		const plugins = (this.app as { plugins?: { plugins?: Record<string, unknown> } }).plugins;
		const tp = plugins?.plugins?.["templater-obsidian"] as
			| { templater?: { create_new_note_from_template?: unknown } }
			| undefined;
		if (tp?.templater?.create_new_note_from_template) {
			return tp as TemplaterPlugin;
		}
		return null;
	}

	override onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("note-creator-modal");

		const noteSection = contentEl.createDiv({ cls: "note-creator-note-section" });
		noteSection.createEl("h2", { text: "Note" });

		new Setting(noteSection)
			.setName("Name")
			.setDesc("The name for the new note")
			.addText((text) => {
				text.setPlaceholder("Enter a name")
					.onChange((value) => {
						this.noteName = value;
					});
			});

		const typeOptions: Record<string, string> = {};
		for (const noteType of this.plugin.settings.types) {
			typeOptions[noteType.id] = noteType.name || "(unnamed type)";
		}
		typeOptions[CUSTOM_TYPE_VALUE] = "Custom...";

		const typeSetting = new Setting(noteSection)
			.setName("Template")
			.setDesc("The existing or custom template for the new note")
			.addDropdown((dropdown) => {
				dropdown.addOption("", "-- Select a template --");
				for (const [key, label] of Object.entries(typeOptions)) {
					dropdown.addOption(key, label);
				}
				dropdown.onChange(async (value) => {
					this.selectedTypeId = value;
					await this.renderFields();
				});
			});
		typeSetting.controlEl.addClass("note-type-selector");

		this.fieldsContainer = contentEl.createDiv({ cls: "note-fields-container" });

		this.actionsContainer = contentEl.createDiv({ cls: "note-creator-actions" });
		this.updateActionButtons();
	}

	private updateActionButtons(): void {
		if (!this.actionsContainer) return;
		this.actionsContainer.empty();

		if (this.selectedTypeId === CUSTOM_TYPE_VALUE) {
			new Setting(this.actionsContainer)
				.addButton((button) => {
					button
						.setButtonText("Add Property")
						.onClick(() => {
							this.customProperties.push({ key: "", value: "", type: "text" });
							this.refreshCustomProperties?.();
						});
				})
				.addButton((button) => {
					button
						.setButtonText("Create")
						.setCta()
						.onClick(() => void this.createNote());
				});
		} else {
			new Setting(this.actionsContainer)
				.addButton((button) => {
					button
						.setButtonText("Create")
						.setCta()
						.onClick(() => void this.createNote());
				});
		}
	}

	private async renderFields(): Promise<void> {
		if (!this.fieldsContainer) return;
		this.fieldsContainer.empty();
		this.frontmatterFields = [];
		this.customProperties = [];
		this.customDestinationFolder = "";
		this.refreshCustomProperties = null;

		if (!this.selectedTypeId) {
			this.updateActionButtons();
			return;
		}

		if (this.selectedTypeId === CUSTOM_TYPE_VALUE) {
			this.renderCustomFields();
			return;
		}

		const noteType = this.plugin.settings.types.find(
			(t) => t.id === this.selectedTypeId
		);
		if (!noteType) return;

		const templateFields = await this.parseTemplateFrontmatter(noteType.templatePath);
		if (templateFields.length === 0) {
			this.fieldsContainer.createEl("p", {
				text: "No frontmatter properties found in the template file.",
				cls: "note-creator-warning",
			});
			this.updateActionButtons();
			return;
		}

		const propertiesHeader = this.fieldsContainer.createDiv({
			cls: "note-custom-properties-header",
		});
		propertiesHeader.createEl("h2", { text: "Properties" });

		for (const { key, value: defaultValue, type: detectedType } of templateFields) {
			const field: FrontmatterField = { key, value: defaultValue, type: detectedType };
			this.frontmatterFields.push(field);

			new Setting(this.fieldsContainer)
				.setName(key)
				.addDropdown((dropdown) => {
					for (const ft of FRONTMATTER_TYPES) {
						dropdown.addOption(ft, FRONTMATTER_TYPE_LABELS[ft]);
					}
					dropdown.setValue(field.type);
					dropdown.onChange((value) => {
						field.type = value as FrontmatterType;
					});
					dropdown.selectEl.addClass("note-field-type-dropdown");
				})
				.addText((text) => {
					text.setPlaceholder(`Enter ${key}`)
						.setValue(defaultValue)
						.onChange((value) => {
							field.value = value;
						});
					new FrontmatterValueSuggest(this.app, text.inputEl, () => field.key);
				});
		}
		this.updateActionButtons();
	}

	private renderCustomFields(): void {
		if (!this.fieldsContainer) return;

		const destFolderSetting = new Setting(this.fieldsContainer)
			.setName("Destination Folder")
			.setDesc("The folder where to create the new note")
			.addSearch((search) => {
				new ModalFolderSuggest(this.app, search.inputEl);
				search.setPlaceholder("path/to/folder")
					.onChange((value) => {
						this.customDestinationFolder = value;
					});
			});
		destFolderSetting.controlEl.closest(".setting-item")?.addClass("note-destination-folder");

		const propertiesHeader = this.fieldsContainer.createDiv({
			cls: "note-custom-properties-header",
		});
		propertiesHeader.createEl("h2", { text: "Properties" });

		const propertiesContainer = this.fieldsContainer.createDiv({
			cls: "note-custom-properties",
		});

		this.refreshCustomProperties = (): void => {
			propertiesContainer.empty();
			for (let i = 0; i < this.customProperties.length; i++) {
				const property = this.customProperties[i];
				if (!property) continue;
				const row = propertiesContainer.createDiv({ cls: "note-custom-property-row" });
				const index = i;

				const keyInput = row.createEl("input", {
					type: "text",
					placeholder: "Enter property name",
					cls: "note-custom-key-input",
				});
				keyInput.value = property.key;
				keyInput.addEventListener("input", () => {
					property.key = keyInput.value;
				});

				const typeSelect = row.createEl("select", {
					cls: "dropdown note-field-type-dropdown",
				});
				for (const ft of FRONTMATTER_TYPES) {
					const option = typeSelect.createEl("option", {
						text: FRONTMATTER_TYPE_LABELS[ft],
						value: ft,
					});
					if (ft === property.type) option.selected = true;
				}
				typeSelect.addEventListener("change", () => {
					property.type = typeSelect.value as FrontmatterType;
				});

				const valueInput = row.createEl("input", {
					type: "text",
					placeholder: "Enter value",
					cls: "note-custom-value-input",
				});
				valueInput.value = property.value;
				valueInput.addEventListener("input", () => {
					property.value = valueInput.value;
				});
				new FrontmatterValueSuggest(this.app, valueInput, () => property.key);

				const removeButton = row.createEl("button", {
					text: "\u2715",
					cls: "note-custom-remove-btn",
				});
				removeButton.addEventListener("click", () => {
					this.customProperties.splice(index, 1);
					this.refreshCustomProperties?.();
				});
			}
		};

		this.refreshCustomProperties();
		this.updateActionButtons();
	}

	private inferType(key: string, value: unknown): FrontmatterType {
		const lowerKey = key.toLowerCase();
		if (lowerKey === "tags") return "tags";
		if (lowerKey === "aliases") return "aliases";

		const typeManager = (
			this.app as {
				metadataTypeManager?: {
					getAssignedType?: (key: string) => string | undefined;
				};
			}
		).metadataTypeManager;

		if (typeManager?.getAssignedType) {
			const assigned = typeManager.getAssignedType(key);
			if (
				assigned &&
				(FRONTMATTER_TYPES as readonly string[]).includes(assigned)
			) {
				return assigned as FrontmatterType;
			}
		}

		if (Array.isArray(value)) return "multitext";
		if (typeof value === "boolean") return "checkbox";
		if (typeof value === "number") return "number";
		if (typeof value === "string") {
			if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return "datetime";
			if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return "date";
		}
		return "text";
	}

	private async parseTemplateFrontmatter(templatePath: string): Promise<FrontmatterField[]> {
		const abstractFile = this.app.vault.getAbstractFileByPath(templatePath);
		if (!abstractFile || !(abstractFile instanceof TFile)) {
			new Notice(`Template file not found: ${templatePath}`);
			return [];
		}

		const cache = this.app.metadataCache.getFileCache(abstractFile);
		if (cache?.frontmatter) {
			return Object.entries(cache.frontmatter)
				.filter(([key]) => key !== "position")
				.map(([key, value]) => ({
					key,
					value: value != null ? String(value) : "",
					type: this.inferType(key, value),
				}));
		}

		return this.parseFrontmatterManually(abstractFile);
	}

	private async parseFrontmatterManually(file: TFile): Promise<FrontmatterField[]> {
		const content = await this.app.vault.read(file);
		const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
		if (!frontmatterMatch?.[1]) return [];

		const frontmatterBlock = frontmatterMatch[1];
		const fields: FrontmatterField[] = [];

		for (const line of frontmatterBlock.split("\n")) {
			const colonIndex = line.indexOf(":");
			if (colonIndex === -1) continue;
			const key = line.slice(0, colonIndex).trim();
			if (!/^\w[\w\s-]*$/.test(key)) continue;
			let value = line.slice(colonIndex + 1).trim();
			if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
				value = value.slice(1, -1).replace(/\\(.)/g, "$1");
			}
			fields.push({ key, value, type: this.inferType(key, value) });
		}

		return fields;
	}

	private async createNote(): Promise<void> {
		if (!this.noteName.trim()) {
			new Notice("Please enter a name for the new note.");
			return;
		}

		if (!this.selectedTypeId) {
			new Notice("Please select a template for the new note.");
			return;
		}

		if (this.selectedTypeId === CUSTOM_TYPE_VALUE) {
			await this.createCustomNote();
		} else {
			await this.createPredefinedNote();
		}
	}

	private async createCustomNote(): Promise<void> {
		if (!this.customDestinationFolder.trim()) {
			new Notice("Please specify a destination folder for the new note.");
			return;
		}

		const destinationFolder = this.customDestinationFolder.trim();
		const frontmatterEntries = this.customProperties.filter((p) => p.key.trim());
		const filePath = `${destinationFolder}/${this.noteName.trim()}.md`;

		const existingFile = this.app.vault.getAbstractFileByPath(filePath);
		if (existingFile) {
			new Notice(`A file already exists at: ${filePath}`);
			return;
		}

		await this.ensureFolderExists(destinationFolder);
		const content = this.buildNoteContent(frontmatterEntries);

		try {
			const newFile = await this.app.vault.create(filePath, content);
			await this.app.workspace.openLinkText(newFile.path, "", false);
			new Notice(`Note created: ${this.noteName.trim()}`);
			this.close();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			new Notice(`Failed to create note: ${message}`);
		}
	}

	private async createPredefinedNote(): Promise<void> {
		const noteType = this.plugin.settings.types.find(
			(t) => t.id === this.selectedTypeId
		);
		if (!noteType) {
			new Notice("Selected type not found.");
			return;
		}

		const destinationFolder = noteType.destinationFolder;
		const filePath = `${destinationFolder}/${this.noteName.trim()}.md`;

		const existingFile = this.app.vault.getAbstractFileByPath(filePath);
		if (existingFile) {
			new Notice(`A file already exists at: ${filePath}`);
			return;
		}

		await this.ensureFolderExists(destinationFolder);

		const templaterPlugin = this.getTemplaterPlugin();
		const templateFile = this.app.vault.getAbstractFileByPath(noteType.templatePath);

		if (templaterPlugin && templateFile instanceof TFile) {
			try {
				await this.createWithTemplater(
					templaterPlugin,
					templateFile,
					destinationFolder,
					this.noteName.trim()
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				new Notice(`Failed to create note: ${message}`);
				return;
			}
		} else {
			const content = this.buildNoteContent(this.frontmatterFields);
			try {
				const newFile = await this.app.vault.create(filePath, content);
				await this.app.workspace.openLinkText(newFile.path, "", false);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				new Notice(`Failed to create note: ${message}`);
				return;
			}
		}

		new Notice(`Note created: ${this.noteName.trim()}`);
		this.close();
	}

	private async createWithTemplater(
		templaterPlugin: TemplaterPlugin,
		templateFile: TFile,
		destinationFolder: string,
		filename: string
	): Promise<void> {
		const folder = this.app.vault.getAbstractFileByPath(destinationFolder);
		if (!(folder instanceof TFolder)) {
			throw new Error(`Destination folder not found: ${destinationFolder}`);
		}

		const newFile = await templaterPlugin.templater.create_new_note_from_template(
			templateFile,
			folder,
			filename,
			true
		);

		if (!newFile) {
			throw new Error("Templater failed to create the note.");
		}

		if (this.frontmatterFields.length > 0) {
			await this.applyFrontmatter(newFile);
		}
	}

	private async applyFrontmatter(file: TFile): Promise<void> {
		await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
			for (const field of this.frontmatterFields) {
				const isEmptyOmit = (field.type === "text" || !field.type || field.type === "date" || field.type === "datetime") && !field.value;
				if (isEmptyOmit) continue;
				frontmatter[field.key] = this.toFrontmatterValue(field.value, field.type);
			}
		});
	}

	private toFrontmatterValue(value: string, type: FrontmatterType): unknown {
		switch (type) {
			case "number": {
				const num = Number(value);
				return Number.isNaN(num) ? 0 : num;
			}
			case "checkbox":
				return value === "true" || value === "1";
			case "multitext":
			case "aliases":
			case "tags":
				return value.split(",").map((s) => s.trim()).filter(Boolean);
			default:
				return value;
		}
	}

	private buildNoteContent(entries: { key: string; value: string; type?: FrontmatterType }[]): string {
		if (entries.length === 0) return "";

		const lines: string[] = ["---"];
		for (const entry of entries) {
			const line = this.formatFrontmatterLine(entry.key, entry.value, entry.type);
			if (line) lines.push(line);
		}
		lines.push("---");
		lines.push("");

		return lines.join("\n");
	}

	private formatFrontmatterLine(key: string, value: string, type?: FrontmatterType): string {
		switch (type) {
			case "number": {
				const num = Number(value);
				return `${key}: ${Number.isNaN(num) ? 0 : num}`;
			}
			case "checkbox":
				return `${key}: ${value === "true" || value === "1" ? "true" : "false"}`;
			case "multitext":
			case "aliases": {
				const items = value.split(",").map((s) => s.trim()).filter(Boolean);
				if (items.length === 0) return `${key}: []`;
				return `${key}:\n${items.map((item) => `  - ${this.quoteYamlString(item)}`).join("\n")}`;
			}
			case "tags": {
				const items = value.split(",").map((s) => s.trim()).filter(Boolean);
				if (items.length === 0) return `${key}: []`;
				return `${key}:\n${items.map((item) => `  - ${this.formatYamlValue(item)}`).join("\n")}`;
			}
			case "date":
			case "datetime":
				if (!value) return "";
				return `${key}: ${value}`;
			default:
				if (!value) return "";
				return `${key}: ${this.formatYamlValue(value)}`;
		}
	}

	private quoteYamlString(value: string): string {
		const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
		return `"${escaped}"`;
	}

	private formatYamlValue(value: string): string {
		if (!value) return "";
		if (
			value.includes(":") ||
			value.includes("#") ||
			value.includes("'") ||
			value.includes('"') ||
			value.includes("\n")
		) {
			return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
		}
		return value;
	}

	private async ensureFolderExists(folderPath: string): Promise<void> {
		const parts = folderPath.split("/");
		let currentPath = "";

		for (const part of parts) {
			currentPath = currentPath ? `${currentPath}/${part}` : part;
			const existing = this.app.vault.getAbstractFileByPath(currentPath);
			if (!existing) {
				await this.app.vault.createFolder(currentPath);
			}
		}
	}

	override onClose(): void {
		this.contentEl.empty();
	}
}
