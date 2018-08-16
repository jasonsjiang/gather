import Jupyter = require('base/js/namespace');
import * as utils from "base/js/utils";
import { Cell, CodeCell, notification_area, Notebook } from 'base/js/namespace';
import { Widget } from '@phosphor/widgets';

import { NotebookCell, copyCodeCell, nbCellToJson } from './NotebookCell';
import { ExecutionLogSlicer, SlicedExecution } from '../slicing/ExecutionSlicer';
import { MarkerManager, ICell, CellEditorResolver, CellOutputResolver } from '../packages/cell';

import { GatherModel, GatherState } from '../packages/gather/model';
import { GatherController } from '../packages/gather/controller';

import { GatherToClipboardButton, ClearButton, GatherToNotebookButton, MergeButton, GatherHistoryButton } from './buttons';
import { ICellClipboard, IClipboardListener } from '../packages/gather/clipboard';
import { INotebookOpener } from '../packages/gather/opener';
import * as log from '../utils/log';
import { RevisionBrowser } from './RevisionBrowser';

import 'codemirror/mode/python/python';
import '../../style/nb-vars.css';
import '../../style/index.css';


/**
 * Widget for gather notifications.
 */
var notificationWidget: Jupyter.NotificationWidget;

/**
 * Logs cell executions.
 */
var executionHistory: ExecutionHistory;

/**
 * Collects log information about the notebook for each log call.
 */
class NbStatePoller implements log.IStatePoller {
    /**
     * Construct a new poller for notebook state.
     * Pass in `logCells` as false if you don't want to log information about the cells and their
     * contents (number, order, total length of text). Collecting the number of cells slows down
     * execution like crazy because of its internal implementation.
     */
    constructor(notebook: Notebook, logCells?: boolean) {
        this._notebook = notebook;
        this._logCells = logCells;
        // If this notebook doesn't have a UUID, assign one. We'll want to use this to
        // disambiguate between the notebooks developers are using gathering in.
        if (!this._notebook.metadata) {
            this._notebook.metadata = {};
        }
        if (!this._notebook.metadata.gatheringId) {
            // This UUID will stay the same across sessions (i.e. when you reload the notebook),
            // as long as the notebook was saved after the UUID was assigned.
            this._notebook.metadata.gatheringId = utils.uuid();
        }
    }

    /**
     * Collect state information about the notebook.
     */
    poll(): any {
        let data: any = {
            gathered: this._notebook.metadata && this._notebook.metadata.gathered,
            uuid: (this._notebook.metadata ? this._notebook.metadata.gatheringId : undefined),
        };
        if (this._logCells) {
            let cells = this._notebook.get_cells();
            data.numCells = cells.length;
            data.codeCellIds = cells
                .filter(c => c.cell_type == "code")
                .map(c => [c.cell_id, (c as CodeCell).input_prompt_number]);
            data.numLines = cells
                .filter(c => c.cell_type == "code")
                .reduce((lineCount, c) => { return lineCount + c.code_mirror.getValue().split("\n").length }, 0)
        }
        return data;
    }

    private _notebook: Notebook;
    private _logCells: boolean = false;
}

/**
 * Saves each cell execution to a history.
 */
class ExecutionHistory {
    readonly executionSlicer = new ExecutionLogSlicer();
    private _cellWithUndefinedCount: ICell;
    private _lastExecutionCount: number;
    private _gatherModel: GatherModel;

    constructor(notebook: Notebook, gatherModel: GatherModel) {
        this._gatherModel = gatherModel;
        // We don't know the order that we will receive events for the kernel finishing execution and
        // a cell finishing execution, so this helps us pair execution count to an executed cell.
        notebook.events.on('shell_reply.Kernel', (
            _: Jupyter.Event, data: { reply: { content: Jupyter.ShellReplyContent } }) => {
            if (this._cellWithUndefinedCount) {
                console.log("Defining cell execution count after the fact...");
                this._cellWithUndefinedCount.executionCount = data.reply.content.execution_count;
                this.executionSlicer.logExecution(this._cellWithUndefinedCount);
                this._cellWithUndefinedCount = undefined;
            } else {
                this._lastExecutionCount = data.reply.content.execution_count;
            }
        });
        notebook.events.on('finished_execute.CodeCell', (_: Jupyter.Event, data: { cell: CodeCell }) => {
            let cellClone = copyCodeCell(data.cell);
            const cell = new NotebookCell(cellClone);
            if (this._lastExecutionCount) {
                cellClone.input_prompt_number = this._lastExecutionCount;
                this.executionSlicer.logExecution(cell);
                this._lastExecutionCount = undefined;
            } else {
                this._cellWithUndefinedCount = cell;
            }
        });
        // Clear the history and selections whenever the kernel has been restarted.Z
        notebook.events.on('kernel_restarting.Kernel', () => {
            this.executionSlicer.reset();
            this._gatherModel.requestStateChange(GatherState.RESET);
        });
    }
}

/**
 * Logs edit and execution events in the notebook.
 */
class NotebookEventLogger {
    /**
     * Construct a new event logger for the notebook.
     */
    constructor(notebook: Notebook) {
        // For each of these events, for all cell data that we want to log, make sure to wrap it
        // first in an `nbCellToJson`---otherwise, logging may crash from circular dependencies, and
        // we may log data that wasn't intended to be logged.
        notebook.events.on('create.Cell', (_: Jupyter.Event, data: { cell: Cell, index: number }) => {
            log.log("Created cell", { cell: nbCellToJson(data.cell), index: data.index });
        })
        notebook.events.on('change.Cell', (_: Jupyter.Event, data: { cell: Cell, change: CodeMirror.EditorChange }) => {
            let change = data.change;
            // Ignore all `setValue` events---these are invoked programatically, like when a new
            // cell is created, or when a cell is executed. The other types of events are more
            // relevant (cut, paste, +input, +delete).
            if (change.origin != "setValue") {
                log.log("Changed contents of cell", {
                    cell: nbCellToJson(data.cell),
                    newCharacters: change.text.reduce((len, line) => { return len + line.length }, 0),
                    removedCharacters: change.removed.reduce((len, line) => { return len + line.length }, 0)
                });
            }
        });
        notebook.events.on('select.Cell', (_: Jupyter.Event, data: { cell: Cell, extendSelection: boolean }) => {
            log.log("Cell selected", {
                cell: nbCellToJson(data.cell),
                extendSelection: data.extendSelection
            });
        });
        notebook.events.on('delete.Cell', (_: Jupyter.Event, data: { cell: Cell, index: number }) => {
            log.log("Deleted cell", { cell: nbCellToJson(data.cell), index: data.index });
        });
        // To my knowledge, the cell that this saves will have the most recent version of the output.
        notebook.events.on('finished_execute.CodeCell', (_: Jupyter.Event, data: { cell: CodeCell }) => {
            log.log("Executed cell", { cell: nbCellToJson(data.cell) });
        });
        notebook.events.on('checkpoint_created.Notebook', () => {
            log.log("Created checkpoint");
        });
        notebook.events.on('checkpoint_failed.Notebook', () => {
            log.log("Failed to create checkpoint");
        });
        // XXX: Triggered by both restoring a checkpoint and deleting it. Weird.
        notebook.events.on('notebook_restoring.Notebook', () => {
            log.log("Attempting to restore checkpoint");
        });
        notebook.events.on('checkpoint_restore_failed.Notebook', () => {
            log.log("Failed to restore checkpoint");
        });
        notebook.events.on('checkpoint_restored.Notebook', () => {
            log.log("Succeeded at restoring checkpoint");
        });
        notebook.events.on('checkpoint_delete_failed.Notebook', () => {
            log.log("Failed to delete checkpoint");
        });
        notebook.events.on('checkpoint_deleted.Notebook', () => {
            log.log("Succeeeded at deleting checkpoint");
        });
        // I don't know how a kernel gets killed---its not clear from the notebook interface.
        notebook.events.on('kernel_killed.Kernel', () => {
            log.log("Kernel killed");
        });
        notebook.events.on('kernel_interrupting.Kernel', () => {
            log.log("Interrupting the kernel");
        });
        notebook.events.on('kernel_restarting.Kernel', () => {
            log.log("Restarting the kernel");
        });
    }
}

/**
 * Gets cell from a notebook. We use this instead of directly accessing cells on the notebook as
 * this can speed up cell accesses for costly cell queries.
 */
class CellFetcher {
    /**
     * Construct a new cell fetcher.
     */
    constructor(notebook: Notebook) {
        this._notebook = notebook;
        // Invalidate the list of cached cells every time the notebook changes.
        this._notebook.events.on("set_dirty.Notebook", () => {
            this._cachedCells = null;
        });
    }

    /**
     * Get a cell from the notebook with the specified properties.
     */
    getCellWidget(cellId: string, executionCount?: number): Cell {
        // If the cells haven't been cached, cache 'em here.
        if (this._cachedCells == null) {
            this._cachedCells = this._notebook.get_cells();
        }
        let matchingCells = this._cachedCells
            .filter(c => {
                if (c.cell_id != cellId) return false;
                if (executionCount != undefined) {
                    if (!(c instanceof CodeCell)) return false;
                    if ((c as CodeCell).input_prompt_number != executionCount) return false;
                }
                return true;
            });
        if (matchingCells.length > 0) {
            return matchingCells.pop();
        }
        return null;
    }

    private _notebook: Notebook;
    private _cachedCells: Cell[] = null;
}

/**
 * Resolve the active editors for cells in Jupyter notebook.
 * This only works for cells that are still in the notebook---i.e. breaks for deleted cells.
 */
class NotebookCellEditorResolver implements CellEditorResolver {
    /**
     * Construct a new cell editor resolver.
     */
    constructor(cellFetcher: CellFetcher) {
        this._cellFetcher = cellFetcher;
    }

    resolve(cell: ICell): CodeMirror.Editor {
        let cellWidget = this._cellFetcher.getCellWidget(cell.id, cell.executionCount);
        if (cellWidget) {
            return cellWidget.code_mirror;
        }
        return null;
    }

    private _cellFetcher: CellFetcher;
}

/**
 * Finds HTML elements for cell outputs in a notebook.
 */
class NotebookCellOutputResolver implements CellOutputResolver {
    /**
     * Construct a new cell editor resolver.
     */
    constructor(cellFetcher: CellFetcher) {
        this._cellFetcher = cellFetcher;
    }

    resolve(cell: ICell): HTMLElement[] {
        let cellWidget = this._cellFetcher.getCellWidget(cell.id, cell.executionCount);
        let outputElements = [];
        if (cellWidget) {
            let cellElement = cellWidget.element[0];
            var outputNodes = cellElement.querySelectorAll(".output_subarea");
            for (var i = 0; i < outputNodes.length; i++) {
                if (outputNodes[i] instanceof HTMLElement) {
                    outputElements.push(outputNodes[i] as HTMLElement);
                }
            }
        }
        return outputElements;
    }

    private _cellFetcher: CellFetcher;
}

/**
 * Highlights gatherable entities.
 */
class ResultsHighlighter {

    private _markerManager: MarkerManager;

    constructor(notebook: Notebook, gatherModel: GatherModel, markerManager: MarkerManager) {
        this._markerManager = markerManager;

        // Listen to the events that change the cells and update the model to report that the cells
        // have changed. These events can be used to update the markers.
        notebook.events.on('finished_execute.CodeCell', (_: Jupyter.Event, data: { cell: CodeCell }) => {
            gatherModel.lastExecutedCell = new NotebookCell(data.cell);
        });
        notebook.events.on('change.Cell', (_: Jupyter.Event, data: { cell: Cell, change: CodeMirror.EditorChange }) => {
            let change = data.change;
            // Ignore all `setValue` events---these are invoked programatically.
            if (change.origin != "setValue" && data.cell instanceof CodeCell) {
                gatherModel.lastEditedCell = new NotebookCell(data.cell);
            }
        });
        notebook.events.on('delete.Cell', (_: Jupyter.Event, data: { cell: Cell, index: number }) => {
            if (data.cell instanceof CodeCell) {
                gatherModel.lastDeletedCell = new NotebookCell(data.cell);
            }
        });

        document.body.addEventListener("mouseup", (event: MouseEvent) => {
            this._markerManager.handleClick(event);
        });
    }
}

/**
 * Convert program slice to list of cell JSONs
 */
function sliceToCellJson(slice: SlicedExecution, annotatePaste?: boolean): CellJson[] {
    const SHOULD_SLICE_CELLS = true;
    const SHOULD_OMIT_NONTERMINAL_OUTPUT = true;
    annotatePaste = annotatePaste || false;
    return slice.cellSlices
        .map((cellSlice, i) => {
            let slicedCell = cellSlice.cell;
            if (SHOULD_SLICE_CELLS) {
                slicedCell = slicedCell.copy();
                slicedCell.text = cellSlice.textSliceLines;
            }
            if (slicedCell instanceof NotebookCell) {
                let cellJson = slicedCell.model.toJSON();
                // This new cell hasn't been executed yet. So don't mark it as having been executed.
                cellJson.execution_count = null;
                // Add a flag to distinguish gathered cells from other cells.
                cellJson.metadata.gathered = true;
                // Add a flag so we can tell if this cell was just pasted, so we can merge it.
                if (annotatePaste) {
                    cellJson.metadata.justPasted = true;
                }
                // If this isn't the last cell, don't include its output.
                if (SHOULD_OMIT_NONTERMINAL_OUTPUT && i != slice.cellSlices.length - 1) {
                    cellJson.outputs = [];
                }
                return cellJson;
            }
        }).filter(c => c);
}

/**
 * Gather code to the clipboard.
 */
class Clipboard implements ICellClipboard {

    addListener(listener: IClipboardListener) {
        this._listeners.push(listener);
    }

    copy(slice: SlicedExecution) {
        if (slice) {
            Jupyter.notebook.clipboard = [];
            let cellsJson = sliceToCellJson(slice, true);
            cellsJson.forEach(c => {
                Jupyter.notebook.clipboard.push(c);
            });
            Jupyter.notebook.enable_paste();
            this._listeners.forEach(listener => listener.onCopy(slice, this));
        }
    }

    private _listeners: IClipboardListener[] = [];
}

/**
 * Opens new notebooks containing program slices.
 */
class NotebookOpener implements INotebookOpener {

    // Pass in the current notebook. This class will open new notebooks.
    constructor(thisNotebook: Notebook) {
        this._notebook = thisNotebook;
    }

    private _openSlice(notebookJson: NotebookJson, gatherIndex: number) {

        // Get the directory of the current notebook.
        let currentDir = document.body.attributes
            .getNamedItem('data-notebook-path').value.split('/').slice(0, -1).join("/");
        currentDir = currentDir ? currentDir + "/" : "";

        // Create path to file
        let fileName = "GatheredCode" + gatherIndex + ".ipynb";
        let notebookPath = currentDir + fileName;

        this._notebook.contents.get(notebookPath, { type: 'notebook' }).then((_) => {
            // If there's already a file at this location, try the next gather index.
            this._openSlice(notebookJson, gatherIndex + 1);
        }, (_) => {
            // Open up a new notebook at an available location.
            let model = { type: "notebook", content: notebookJson };
            this._notebook.contents.save(notebookPath, model).then(() => {
                // XXX: This seems to open up a file in different places on different machines???
                window.open(fileName + "?kernel_name=python3", '_blank');
            });
        });
    }

    openNotebookForSlice(slice: SlicedExecution) {

        // Make boilerplate, empty notebook JSON.
        let notebookJson = this._notebook.toJSON();
        notebookJson.cells = [];
        notebookJson.metadata.gathered = true;

        // Replace the notebook model's cells with the copied cells.
        if (slice) {
            let cellsJson = sliceToCellJson(slice, false);
            for (let i = 0; i < cellsJson.length; i++) {
                let cellJson = cellsJson[i];
                notebookJson.cells.push(cellJson);
            }

            // Save the gathered code to a new notebook, and then open it.
            this._openSlice(notebookJson, 1);
        }
    }

    private _notebook: Notebook;
}

/**
 * Prefix for all gather actions.
 */
const GATHER_PREFIX = 'gather_extension';

export function load_ipython_extension() {
    console.log('extension started');

    /**
     * Initialize logging.
     */
    const LOG_NB_CELLS = false;
    log.initLogger({ ajax: utils.ajax });
    log.registerPollers(new NbStatePoller(Jupyter.notebook, LOG_NB_CELLS));
    new NotebookEventLogger(Jupyter.notebook);

    // Object containing global UI state.
    let gatherModel = new GatherModel();

    // Plugin initializations.
    executionHistory = new ExecutionHistory(Jupyter.notebook, gatherModel);
    let cellFetcher = new CellFetcher(Jupyter.notebook);
    let markerManager = new MarkerManager(gatherModel,
        new NotebookCellEditorResolver(cellFetcher),
        new NotebookCellOutputResolver(cellFetcher));
    new ResultsHighlighter(Jupyter.notebook, gatherModel, markerManager);

    // Initialize clipboard for copying cells.
    let clipboard = new Clipboard();
    clipboard.addListener({
        onCopy: () => {
            if (notificationWidget) {
                notificationWidget.set_message("Copied cells. To paste, type 'v' or right-click.", 5000);
            }
        }
    });

    // Initialize utility for opening new notebooks.
    let opener = new NotebookOpener(Jupyter.notebook);

    // Controller for global UI state.
    new GatherController(gatherModel, executionHistory.executionSlicer, clipboard, opener);

    // Set up toolbar with gather actions.
    let gatherToClipboardButton = new GatherToClipboardButton(gatherModel);
    let gatherToNotebookButton = new GatherToNotebookButton(gatherModel);
    let gatherHistoryButton = new GatherHistoryButton(gatherModel);
    let clearButton = new ClearButton(gatherModel);

    // Create buttons for gathering.
    let buttonsGroup = Jupyter.toolbar.add_buttons_group(
        [gatherToClipboardButton, gatherToNotebookButton, gatherHistoryButton, clearButton]
            .map(b => ({
                label: b.label,
                icon: b.action.icon,
                callback: b.action.handler,
                action: Jupyter.actions.register(b.action, b.actionName, GATHER_PREFIX)
            }))
    );

    // Add a label to the gathering part of the toolbar.
    let gatherLabel = document.createElement("div");
    gatherLabel.textContent = "Gather to:";
    gatherLabel.classList.add("jp-Toolbar-gatherlabel");
    buttonsGroup[0].insertBefore(gatherLabel, buttonsGroup.children()[0]);

    // Finish initializing the buttons.
    gatherToClipboardButton.node = new Widget({ node: buttonsGroup.children()[1] });
    gatherToNotebookButton.node = new Widget({ node: buttonsGroup.children()[2] });
    gatherHistoryButton.node = new Widget({ node: buttonsGroup.children()[3] });
    clearButton.node = new Widget({ node: buttonsGroup.children()[4] });

    let mergeButton = new MergeButton(Jupyter.actions, Jupyter.notebook);
    let mergeButtonGroup = Jupyter.toolbar.add_buttons_group(
        [{
            label: mergeButton.label,
            icon: mergeButton.action.icon,
            callback: mergeButton.action.handler,
            action: Jupyter.actions.register(mergeButton.action, mergeButton.actionName, GATHER_PREFIX)
        }]
    );
    mergeButton.node = new Widget({ node: mergeButtonGroup.children()[0] });

    // Add widget for viewing history
    let revisionBrowser = new RevisionBrowser(gatherModel);
    document.body.appendChild(revisionBrowser.node);

    // When pasting gathered cells, select those cells. This is hacky: we add a flag to the
    // gathered cells (justPasted) so we can find them right after the paste, as there is no
    // listener for pasting gathered cells in the notebook API.
    Jupyter.notebook.events.on('select.Cell', (_: Jupyter.Event, data: { cell: Cell }) => {

        let cell = data.cell;
        if (cell.metadata.justPasted) {

            // Select all of the gathered cells.
            let gatheredCellIndexes = cell.notebook.get_cells()
                .map((c, i): [Cell, number] => [c, i])
                .filter(([c, i]) => c.metadata.justPasted)
                .map(([c, i]) => i);
            let firstGatheredIndex = Math.min(...gatheredCellIndexes);
            let lastGatheredIndex = Math.max(...gatheredCellIndexes);
            Jupyter.notebook.select(firstGatheredIndex, true);
            Jupyter.notebook.select(lastGatheredIndex, false);

            // We won't use the `gathered` flag on these cells anymore, so remove them from the cells.
            cell.notebook.get_cells()
                .forEach(c => {
                    if (c.metadata.justPasted) {
                        delete c.metadata.justPasted;
                    }
                });
        }
    });

    notificationWidget = notification_area.new_notification_widget("gather");
}
