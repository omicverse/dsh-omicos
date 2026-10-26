# OmicOS OSS persistent R worker. Trusted local code, not a security sandbox.
if (!requireNamespace('jsonlite', quietly = TRUE)) stop('R worker requires jsonlite in the selected R environment; install it explicitly before running R cells.')
args <- commandArgs(trailingOnly = TRUE)
workspace <- normalizePath(args[[1]], mustWork = TRUE)
setwd(workspace)
# R cannot reopen Node's Unix-domain socket via /dev/fd on Linux.
# popen supplies a real pipe; the Node relay writes the inherited private fd.
wire <- if (length(args) >= 3) pipe(paste('ELECTRON_RUN_AS_NODE=1', shQuote(args[[2]]), shQuote(args[[3]])), open = 'w') else file('/dev/fd/3', open = 'w')
input <- file('stdin', open = 'r')
emit <- function(value) { writeLines(jsonlite::toJSON(value, auto_unbox = TRUE, null = 'null', na = 'null'), wire); flush(wire) }
namespace <- new.env(parent = globalenv())
options(warn = 1)
variables <- function() {
  names <- head(ls(namespace, all.names = FALSE), 500)
  unname(lapply(names, function(name) {
    value <- get(name, envir = namespace)
    shape <- dim(value)
    preview <- if (is.atomic(value) && length(value) <= 5) paste(value, collapse = ', ') else paste(class(value), 'length', length(value), collapse = ' ')
    list(name = name, type = paste(class(value), collapse = '/'), shape = if (is.null(shape)) NULL else paste(shape, collapse = ' x '), preview = substr(preview, 1, 200))
  }))
}
installed <- utils::installed.packages()
package_names <- c('jsonlite', 'Seurat', 'SingleCellExperiment', 'DESeq2', 'edgeR', 'ggplot2')
package_versions <- setNames(lapply(package_names, function(name) if (name %in% rownames(installed)) unname(installed[name, 'Version']) else NULL), package_names)
emit(list(type = 'ready', environment = list(language = 'r', version = R.version.string, executable = file.path(R.home('bin'), 'Rscript'), platform = R.version$platform, packages = package_versions)))
repeat {
  line <- readLines(input, n = 1, warn = FALSE)
  if (length(line) == 0) break
  command <- jsonlite::fromJSON(line, simplifyVector = FALSE)
  error <- NULL; canceled <- FALSE; artifacts <- list(); plotted <- NULL; device <- NULL
  directory <- file.path(workspace, '.omicos-oss', 'artifacts', command$id)
  dir.create(directory, recursive = TRUE, showWarnings = FALSE)
  pdfpath <- file.path(directory, 'figure.pdf')
  outputpath <- file.path(directory, 'cell-output.tmp')
  output <- file(outputpath, open = 'wt')
  sinkdepth <- sink.number()
  sink(output)
  sink(output, type = 'message')
  tryCatch({
    grDevices::pdf(pdfpath)
    device <- grDevices::dev.cur()
    grDevices::dev.control(displaylist = 'enable')
    result <- withVisible(eval(parse(text = command$code, keep.source = TRUE), envir = namespace))
    if (result$visible) print(result$value)
  }, interrupt = function(condition) {
    canceled <<- TRUE
    error <<- 'R execution canceled; partial changes may remain in the namespace.'
  }, error = function(condition) { error <<- conditionMessage(condition) })
  if (!is.null(device) && device %in% grDevices::dev.list()) {
    grDevices::dev.set(device)
    recording <- grDevices::recordPlot()
    if (length(recording[[1]]) > 0) plotted <- recording
    invisible(grDevices::dev.off(device))
  }
  if (!is.null(plotted)) {
    relative <- file.path('.omicos-oss', 'artifacts', command$id)
    artifacts[[length(artifacts) + 1]] <- list(id = paste0(command$id, '-pdf'), path = file.path(relative, 'figure.pdf'), mime = 'application/pdf')
    pngpath <- file.path(directory, 'figure.png')
    tryCatch({
      grDevices::png(pngpath, width = 1400, height = 1000, res = 150, type = if (capabilities('cairo')) 'cairo' else getOption('bitmapType'))
      previewdevice <- grDevices::dev.cur()
      grDevices::replayPlot(plotted)
      invisible(grDevices::dev.off(previewdevice))
      artifacts[[length(artifacts) + 1]] <- list(id = paste0(command$id, '-png'), path = file.path(relative, 'figure.png'), mime = 'image/png')
    }, error = function(condition) { cat('R figure preview unavailable:', conditionMessage(condition), '\n', file = stderr()) })
  } else if (file.exists(pdfpath)) unlink(pdfpath)
  sink(type = 'message')
  while (sink.number() > sinkdepth) sink()
  flush(output); close(output)
  size <- file.info(outputpath)$size
  if (!is.na(size) && size > 0) {
    captured <- file(outputpath, open = 'rb')
    invisible(seek(captured, where = max(0, size - 128000), origin = 'start'))
    bytes <- readBin(captured, what = 'raw', n = min(size, 128000))
    close(captured)
    text <- iconv(rawToChar(bytes), from = 'UTF-8', to = 'UTF-8', sub = '?')
    emit(list(id = command$id, type = 'output', text = text))
  }
  unlink(outputpath)
  emit(list(id = command$id, type = 'done', error = error, canceled = canceled, variables = variables(), artifacts = artifacts))
}
