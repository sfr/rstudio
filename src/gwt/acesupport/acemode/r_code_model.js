/*
 * r_code_model.js
 *
 * Copyright (C) 2009-12 by RStudio, Inc.
 *
 * Unless you have received this program directly from RStudio pursuant
 * to the terms of a commercial license agreement with RStudio, then
 * this program is licensed to you under the terms of version 3 of the
 * GNU Affero General Public License. This program is distributed WITHOUT
 * ANY EXPRESS OR IMPLIED WARRANTY, INCLUDING THOSE OF NON-INFRINGEMENT,
 * MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE. Please refer to the
 * AGPL (http://www.gnu.org/licenses/agpl-3.0.txt) for more details.
 *
 */

define("mode/r_code_model", function(require, exports, module) {

var Range = require("ace/range").Range;
var TokenIterator = require("ace/token_iterator").TokenIterator;
var TokenCursor = require("mode/token_cursor").TokenCursor;
var TokenUtils = require("mode/token_utils").TokenUtils;

var $verticallyAlignFunctionArgs = false;

function comparePoints(pos1, pos2)
{
   if (pos1.row != pos2.row)
      return pos1.row - pos2.row;
   return pos1.column - pos2.column;
}

var ScopeManager = require("mode/r_scope_tree").ScopeManager;

var RCodeModel = function(doc, tokenizer, statePattern, codeBeginPattern) {

   
   this.$doc = doc;
   this.$tokenizer = tokenizer;

   this.$tokens = new Array(doc.getLength());
   this.$endStates = new Array(doc.getLength());
   this.$statePattern = statePattern;
   this.$codeBeginPattern = codeBeginPattern;

   this.$tokenUtils = new TokenUtils(
      this.$doc,
      this.$tokenizer,
      this.$tokens,
      this.$statePattern,
      this.$codeBeginPattern
   );
   
   this.$scopes = new ScopeManager();

   var that = this;
   this.$doc.on('change', function(evt) {
      that.$onDocChange.apply(that, [evt]);
   });

   this.$tokenCursor = new TokenCursor(this.$tokens);
};

(function () {

   this.$complements = {
      '(': ')',
      ')': '(',
      '[': ']',
      ']': '[',
      '{': '}',
      '}': '{'
   };

   function pFunction(t)
   {
      return t.type == 'keyword' && t.value == 'function';
   }

   function pAssign(t)
   {
      return /\boperator\b/.test(t.type) && /^(=|<-|<<-)$/.test(t.value);
   }

   function pIdentifier(t)
   {
      return /\bidentifier\b/.test(t.type);
   }

   function findAssocFuncToken(tokenCursor)
   {
      if (tokenCursor.currentValue() !== "{")
         return false;
      if (!tokenCursor.moveBackwardOverMatchingParens())
         return false;
      if (!tokenCursor.moveToPreviousToken())
         return false;
      if (!pFunction(tokenCursor.currentToken()))
         return false;
      if (!tokenCursor.moveToPreviousToken())
         return false;
      if (!pAssign(tokenCursor.currentToken()))
         return false;
      if (!tokenCursor.moveToPreviousToken())
         return false;
      if (!pIdentifier(tokenCursor.currentToken()))
         return false;

      return true;
   }

   this.$buildScopeTreeUpToRow = function(maxrow)
   {
      function maybeEvaluateLiteralString(value) {
         // NOTE: We could evaluate escape sequences and whatnot here as well.
         //       Hard to imagine who would abuse Rnw by putting escape
         //       sequences in chunk labels, though.
         var match = /^(['"])(.*)\1$/.exec(value);
         if (!match)
            return value;
         else
            return match[2];
      }

      function getChunkLabel(reOptions, comment) {
         var match = reOptions.exec(comment);
         if (!match)
            return null;
         var value = match[1];
         var values = value.split(',');
         if (values.length == 0)
            return null;

         // If first arg has no =, it's a label
         if (!/=/.test(values[0])) {
            return values[0].replace(/(^\s+)|(\s+$)/g, '');
         }

         for (var i = 0; i < values.length; i++) {
            match = /^\s*label\s*=\s*(.*)$/.exec(values[i]);
            if (match) {
               return maybeEvaluateLiteralString(
                                        match[1].replace(/(^\s+)|(\s+$)/g, ''));
            }
         }

         return null;
      }

      // It's possible that determining the scope at 'position' may require
      // parsing beyond the position itself--for example if the position is
      // on the identifier of a function whose open brace is a few tokens later.
      // Seems like it would be rare indeed for this distance to be more than 30
      // rows.
      var maxRow = Math.min(maxrow + 30, this.$doc.getLength() - 1);
      this.$tokenUtils.$tokenizeUpToRow(maxRow);

      //console.log("Seeking to " + this.$scopes.parsePos.row + "x"+ this.$scopes.parsePos.column);
      var tokenCursor = this.$tokenCursor.cloneCursor();
      if (!tokenCursor.seekToNearestToken(this.$scopes.parsePos, maxRow))
         return;

      do
      {
         this.$scopes.parsePos = tokenCursor.currentPosition();
         this.$scopes.parsePos.column += tokenCursor.currentValue().length;

         //console.log("                                 Token: " + tokenCursor.currentValue() + " [" + tokenCursor.currentPosition().row + "x" + tokenCursor.currentPosition().column + "]");

         var tokenType = tokenCursor.currentToken().type;
         if (/\bsectionhead\b/.test(tokenType))
         {
            var sectionHeadMatch = /^#+'?[-=#\s]*(.*?)\s*[-=#]+\s*$/.exec(
                  tokenCursor.currentValue());

            var label = "" + sectionHeadMatch[1];
            if (label.length == 0)
               label = "(Untitled)";
            if (label.length > 50)
               label = label.substring(0, 50) + "...";

            this.$scopes.onSectionHead(label, tokenCursor.currentPosition());
         }
         else if (/\bcodebegin\b/.test(tokenType))
         {
            var chunkStartPos = tokenCursor.currentPosition();
            var chunkPos = {row: chunkStartPos.row + 1, column: 0};
            var chunkNum = this.$scopes.getTopLevelScopeCount()+1;
            var chunkLabel = getChunkLabel(this.$codeBeginPattern,
                                           tokenCursor.currentValue());
            var scopeName = "Chunk " + chunkNum;
            if (chunkLabel)
               scopeName += ": " + chunkLabel;
            this.$scopes.onChunkStart(chunkLabel,
                                      scopeName,
                                      chunkStartPos,
                                      chunkPos);
         }
         else if (/\bcodeend\b/.test(tokenType))
         {
            var pos = tokenCursor.currentPosition();
            // Close any open functions
            while (this.$scopes.onScopeEnd(pos))
            {
            }

            pos.column += tokenCursor.currentValue().length;
            this.$scopes.onChunkEnd(pos);
         }
         else if (tokenCursor.currentValue() === "{")
         {
            var localCursor = tokenCursor.cloneCursor();
            var startPos;
            if (findAssocFuncToken(localCursor))
            {
               startPos = localCursor.currentPosition();
               if (localCursor.isFirstSignificantTokenOnLine())
                  startPos.column = 0;
               this.$scopes.onFunctionScopeStart(localCursor.currentValue(),
                                                 startPos,
                                                 tokenCursor.currentPosition());
            }
            else
            {
               startPos = tokenCursor.currentPosition();
               if (tokenCursor.isFirstSignificantTokenOnLine())
                  startPos.column = 0;
               this.$scopes.onScopeStart(startPos);
            }
         }
         else if (tokenCursor.currentValue() === "}")
         {
            var pos = tokenCursor.currentPosition();
            if (tokenCursor.isLastSignificantTokenOnLine())
            {
               pos.column = this.$getLine(pos.row).length + 1;
            }
            else
            {
               pos.column++;
            }
            this.$scopes.onScopeEnd(pos);
         }
      } while (tokenCursor.moveToNextToken(maxRow));
   };

   this.$getFoldToken = function(session, foldStyle, row) {
      this.$tokenUtils.$tokenizeUpToRow(row);

      if (this.$statePattern && !this.$statePattern.test(this.$endStates[row]))
         return "";

      var rowTokens = this.$tokens[row];

      if (rowTokens.length == 1 && /\bsectionhead\b/.test(rowTokens[0].type))
         return rowTokens[0];

      var depth = 0;
      var unmatchedOpen = null;
      var unmatchedClose = null;

      for (var i = 0; i < rowTokens.length; i++) {
         var token = rowTokens[i];
         if (/\bparen\b/.test(token.type)) {
            switch (token.value) {
               case '{':
                  depth++;
                  if (depth == 1) {
                     unmatchedOpen = token;
                  }
                  break;
               case '}':
                  depth--;
                  if (depth == 0) {
                     unmatchedOpen = null;
                  }
                  if (depth < 0) {
                     unmatchedClose = token;
                     depth = 0;
                  }
                  break;
            }
         }
      }

      if (unmatchedOpen)
         return unmatchedOpen;

      if (foldStyle == "markbeginend" && unmatchedClose)
         return unmatchedClose;

      if (rowTokens.length >= 1) {
         if (/\bcodebegin\b/.test(rowTokens[0].type))
            return rowTokens[0];
         else if (/\bcodeend\b/.test(rowTokens[0].type))
            return rowTokens[0];
      }

      return null;
   };

   this.getFoldWidget = function(session, foldStyle, row) {
      var foldToken = this.$getFoldToken(session, foldStyle, row);
      if (foldToken == null)
         return "";
      if (foldToken.value == '{')
         return "start";
      else if (foldToken.value == '}')
         return "end";
      else if (/\bcodebegin\b/.test(foldToken.type))
         return "start";
      else if (/\bcodeend\b/.test(foldToken.type))
         return "end";
      else if (/\bsectionhead\b/.test(foldToken.type))
         return "start";

      return "";
   };

   this.getFoldWidgetRange = function(session, foldStyle, row) {
      var foldToken = this.$getFoldToken(session, foldStyle, row);
      if (!foldToken)
         return;

      var pos = {row: row, column: foldToken.column + 1};

      if (foldToken.value == '{') {
         var end = session.$findClosingBracket(foldToken.value, pos);
         if (!end)
            return;
         return Range.fromPoints(pos, end);
      }
      else if (foldToken.value == '}') {
         var start = session.$findOpeningBracket(foldToken.value, pos);
         if (!start)
            return;
         return Range.fromPoints({row: start.row, column: start.column+1},
                                 {row: pos.row, column: pos.column-1});
      }
      else if (/\bcodebegin\b/.test(foldToken.type)) {
         // Find next codebegin or codeend
         var tokenIterator = new TokenIterator(session, row, 0);
         for (var tok; tok = tokenIterator.stepForward(); ) {
            if (/\bcode(begin|end)\b/.test(tok.type)) {
               var begin = /\bcodebegin\b/.test(tok.type);
               var tokRow = tokenIterator.getCurrentTokenRow();
               var endPos = begin
                     ? {row: tokRow-1, column: session.getLine(tokRow-1).length}
                     : {row: tokRow, column: session.getLine(tokRow).length};
               return Range.fromPoints(
                     {row: row, column: foldToken.column + foldToken.value.length},
                     endPos);
            }
         }
         return;
      }
      else if (/\bcodeend\b/.test(foldToken.type)) {
         var tokenIterator2 = new TokenIterator(session, row, 0);
         for (var tok2; tok2 = tokenIterator2.stepBackward(); ) {
            if (/\bcodebegin\b/.test(tok2.type)) {
               var tokRow2 = tokenIterator2.getCurrentTokenRow();
               return Range.fromPoints(
                     {row: tokRow2, column: session.getLine(tokRow2).length},
                     {row: row, column: session.getLine(row).length});
            }
         }
         return;
      }
      else if (/\bsectionhead\b/.test(foldToken.type)) {
         var match = /([-=#])\1+\s*$/.exec(foldToken.value);
         if (!match)
            return;  // this would be surprising

         pos.column += match.index - 1; // Not actually sure why -1 is needed
         var tokenIterator3 = new TokenIterator(session, row, 0);
         var lastRow = row;
         for (var tok3; tok3 = tokenIterator3.stepForward(); ) {
            if (/\bsectionhead\b/.test(tok3.type)) {
               break;
            }
            lastRow = tokenIterator3.getCurrentTokenRow();
         }

         return Range.fromPoints(
               pos,
               {row: lastRow, column: session.getLine(lastRow).length});
      }

      return;
   };

   this.getCurrentScope = function(position, filter)
   {
      if (!filter)
         filter = function(scope) { return true; };

      if (!position)
         return "";
      this.$buildScopeTreeUpToRow(position.row);

      var scopePath = this.$scopes.getActiveScopes(position);
      if (scopePath)
      {
         for (var i = scopePath.length-1; i >= 0; i--) {
            if (filter(scopePath[i]))
               return scopePath[i];
         }
      }

      return null;
   };

   this.getScopeTree = function()
   {
      this.$buildScopeTreeUpToRow(this.$doc.getLength() - 1);
      return this.$scopes.getScopeList();
   };

   this.findFunctionDefinitionFromUsage = function(usagePos, functionName)
   {
      this.$buildScopeTreeUpToRow(this.$doc.getLength() - 1);
      return this.$scopes.findFunctionDefinitionFromUsage(usagePos,
                                                          functionName);
   };

   this.getIndentForOpenBrace = function(pos)
   {
      if (this.$tokenUtils.$tokenizeUpToRow(pos.row))
      {
         var tokenCursor = this.$tokenCursor.cloneCursor();
         if (tokenCursor.seekToNearestToken(pos, pos.row)
                   && tokenCursor.currentValue() == "{"
               && tokenCursor.moveBackwardOverMatchingParens())
         {
            return this.$getIndent(this.$getLine(tokenCursor.currentPosition().row));
         }
      }

      return this.$getIndent(this.$getLine(pos.row));
   };

   this.getNextLineIndent = function(lastRow, line, endState, tab, tabSize)
   {
      if (endState == "qstring" || endState == "qqstring")
         return "";

      // TODO: optimize
      var tabAsSpaces = Array(tabSize + 1).join(" ");

      // This lineOverrides nonsense is necessary because the line has not 
      // changed in the real document yet. We need to simulate it by replacing
      // the real line with the `line` param, and when we finish with this
      // method, undo the damage and invalidate the row.
      // To repro the problem without using lineOverrides, comment out this
      // block of code, and in the editor hit Enter in the middle of a line 
      // that contains a }.
      this.$lineOverrides = null;
      if (!(this.$doc.getLine(lastRow) === line))
      {
         this.$lineOverrides = {};
         this.$lineOverrides[lastRow] = line;
         this.$tokenUtils.$invalidateRow(lastRow);
      }
      
      try
      {
         var defaultIndent = lastRow < 0 ? "" 
                                         : this.$getIndent(this.$getLine(lastRow));

         // jcheng 12/7/2013: It doesn't look to me like $tokenUtils.$tokenizeUpToRow can return
         // anything but true, at least not today.
         if (!this.$tokenUtils.$tokenizeUpToRow(lastRow))
            return defaultIndent;

         // If we're in an Sweave/Rmd/etc. document and this line isn't R, then
         // don't auto-indent
         if (this.$statePattern && !this.$statePattern.test(endState))
            return defaultIndent;

         // Used to add extra whitspace if the next line is a continuation of the
         // previous line (i.e. the last significant token is a binary operator).
         var continuationIndent = "";

         // The significant token (no whitespace, comments) that most immediately
         // precedes this line. We don't look back further than 10 rows or so for
         // performance reasons.
         var prevToken = this.$tokenUtils.$findPreviousSignificantToken(
            {
               row: lastRow,
               column: this.$getLine(lastRow).length
            },
            lastRow - 10
         );

         if (prevToken
               && /\bparen\b/.test(prevToken.token.type)
               && /\)$/.test(prevToken.token.value))
         {
            // The previous token was a close-paren ")". Check if this is an
            // if/while/for/function without braces, in which case we need to
            // take the indentation of the keyword and indent by one level.
            //
            // Example:
            // if (identical(foo, 1) &&
            //     isTRUE(bar) &&
            //     (!is.null(baz) && !is.na(baz)))
            //   |
            var openParenPos = this.$tokenUtils.$walkParensBalanced(
                  prevToken.row,
                  prevToken.row - 10,
                  null,
                  function(parens, paren, pos)
                  {
                     return parens.length === 0;
                  },
                  this.$complements
            );

            if (openParenPos != null)
            {
               var preParenToken = this.$tokenUtils.$findPreviousSignificantToken(openParenPos, 0);
               if (preParenToken && preParenToken.token.type === "keyword"
                     && /^(if|while|for|function)$/.test(preParenToken.token.value))
               {
                  return this.$getIndent(this.$getLine(preParenToken.row)) + tab;
               }
            }
         }
         else if (prevToken
                     && prevToken.token.type === "keyword"
                     && (prevToken.token.value === "repeat" || prevToken.token.value === "else"))
         {
            // Check if this is a "repeat" or (more commonly) "else" without
            // braces, in which case we need to take the indent of the else/repeat
            // and increase by one level.
            return this.$getIndent(this.$getLine(prevToken.row)) + tab;
         }
         else if (prevToken && /\boperator\b/.test(prevToken.token.type) && !/\bparen\b/.test(prevToken.token.type))
         {
            // Fix issue 2579: If the previous significant token is an operator
            // (commonly, "+" when used with ggplot) then this line is a
            // continuation of an expression that was started on a previous
            // line. This line's indent should then be whatever would normally
            // be used for a complete statement starting here, plus a tab.
            continuationIndent = tab;
         }

         // Walk backwards looking for an open paren, square bracket, or curly
         // brace, *ignoring matched pairs along the way*. (That's the "balanced"
         // in $tokenUtils.$walkParensBalanced.)
         var openBracePos = this.$tokenUtils.$walkParensBalanced(
               lastRow,
               0,
               function(parens, paren, pos)
               {
                  return /[\[({]/.test(paren) && parens.length === 0;
               },
               null,
               this.$complements
         );

         if (openBracePos != null)
         {
            // OK, we found an open brace; this just means we're not a
            // top-level expression.

            var nextTokenPos = null;

            if ($verticallyAlignFunctionArgs) {
               // If the user has selected verticallyAlignFunctionArgs mode in the
               // prefs, for example:
               //
               // soDomethingAwesome(a = 1,
               //                    b = 2,
               //                    c = 3)
               //
               // Then we simply follow the example of the next significant
               // token. BTW implies that this mode also supports this:
               //
               // soDomethingAwesome(
               //   a = 1,
               //   b = 2,
               //   c = 3)
               //
               // But not this:
               //
               // soDomethingAwesome(a = 1,
               //   b = 2,
               //   c = 3)
               nextTokenPos = this.$tokenUtils.$findNextSignificantToken(
                     {
                        row: openBracePos.row,
                        column: openBracePos.column + 1
                     }, lastRow);
            }

            if (!nextTokenPos)
            {
               // Either there wasn't a significant token between the new
               // line and the previous open brace, or, we're not in
               // vertical argument alignment mode. Either way, we need
               // to just indent one level from the open brace's level.
               return this.getIndentForOpenBrace(openBracePos) +
                      tab + continuationIndent;
            }
            else
            {
               // Return indent up to next token position.
               // Note that in hard tab mode, the tab character only counts 
               // as a single character unfortunately. What we really want
               // is the screen column, but what we have is the document
               // column, which we can't convert to screen column without
               // copy-and-pasting a bunch of code from layer/text.js.
               // As a shortcut, we just pull off the leading whitespace
               // from the line and include it verbatim in the new indent.
               // This strategy works fine unless there is a tab in the
               // line that comes after a non-whitespace character, which
               // seems like it should be rare.
               var line = this.$getLine(nextTokenPos.row);
               var leadingIndent = line.replace(/[^\s].*$/, '');

               var indentWidth = nextTokenPos.column - leadingIndent.length;
               var tabsToUse = Math.floor(indentWidth / tabSize);
               var spacesToAdd = indentWidth - (tabSize * tabsToUse);
               var buffer = "";
               for (var i = 0; i < tabsToUse; i++)
                  buffer += tab;
               for (var j = 0; j < spacesToAdd; j++)
                  buffer += " ";
               var result = leadingIndent + buffer;

               // Compute the size of the indent in spaces (e.g. if a tab
               // is 4 spaces, and result is "\t\t ", the size is 9)
               var resultSize = result.replace("\t", tabAsSpaces).length;

               // Sometimes even though verticallyAlignFunctionArgs is used,
               // the user chooses to manually "break the rules" and use the
               // non-aligned style, like so:
               //
               // plot(foo,
               //   bar, baz,
               //
               // Without the below loop, hitting Enter after "baz," causes
               // the cursor to end up aligned with foo. The loop simply
               // replaces the indentation with the minimal indentation.
               //
               // TODO: Perhaps we can skip the above few lines of code if
               // there are other lines present
               var thisIndent;
               for (var i = nextTokenPos.row + 1; i <= lastRow; i++) {
                  // If a line contains only whitespace, it doesn't count
                  if (!/[^\s]/.test(this.$getLine(i)))
                     continue;
                  // If this line is is a continuation of a multi-line string, 
                  // ignore it.
                  var rowEndState = this.$endStates[i-1];
                  if (rowEndState === "qstring" || rowEndState === "qqstring") 
                     continue;
                  thisIndent = this.$getLine(i).replace(/[^\s].*$/, '');
                  var thisIndentSize = thisIndent.replace("\t", tabAsSpaces).length;
                  if (thisIndentSize < resultSize) {
                     result = thisIndent;
                     resultSize = thisIndentSize;
                  }
               }

               return result + continuationIndent;
            }
         }

         var firstToken = this.$tokenUtils.$findNextSignificantToken({row: 0, column: 0}, lastRow);
         if (firstToken)
            return this.$getIndent(this.$getLine(firstToken.row)) + continuationIndent;
         else
            return "" + continuationIndent;
      }
      finally
      {
         if (this.$lineOverrides)
         {
            this.$lineOverrides = null;
            this.$tokenUtils.$invalidateRow(lastRow);
         }
      }
   };

   this.getBraceIndent = function(lastRow)
   {
      this.$tokenUtils.$tokenizeUpToRow(lastRow);

      var prevToken = this.$tokenUtils.$findPreviousSignificantToken({row: lastRow, column: this.$getLine(lastRow).length},
                                                         lastRow - 10);
      if (prevToken
            && /\bparen\b/.test(prevToken.token.type)
            && /\)$/.test(prevToken.token.value))
      {
         var lastPos = this.$tokenUtils.$walkParensBalanced(
               prevToken.row,
               prevToken.row - 10,
               null,
               function(parens, paren, pos)
               {
                  return parens.length == 0;
               },
               this.$complements
         );

         if (lastPos != null)
         {
            var preParenToken = this.$tokenUtils.$findPreviousSignificantToken(lastPos, 0);
            if (preParenToken && preParenToken.token.type === "keyword"
                  && /^(if|while|for|function)$/.test(preParenToken.token.value))
            {
               return this.$getIndent(this.$getLine(preParenToken.row));
            }
         }
      }
      else if (prevToken
                  && prevToken.token.type === "keyword"
                  && (prevToken.token.value === "repeat" || prevToken.token.value === "else"))
      {
         return this.$getIndent(this.$getLine(prevToken.row));
      }

      return this.$getIndent(lastRow);
   };

   this.$onDocChange = function(evt)
   {
      var delta = evt.data;

      if (delta.action === "insertLines")
      {
         this.$tokenUtils.$insertNewRows(delta.range.start.row,
                             delta.range.end.row - delta.range.start.row);
      }
      else if (delta.action === "insertText")
      {
         if (this.$doc.isNewLine(delta.text))
         {
            this.$tokenUtils.$invalidateRow(delta.range.start.row);
            this.$tokenUtils.$insertNewRows(delta.range.end.row, 1);
         }
         else
         {
            this.$tokenUtils.$invalidateRow(delta.range.start.row);
         }
      }
      else if (delta.action === "removeLines")
      {
         this.$tokenUtils.$removeRows(delta.range.start.row,
                          delta.range.end.row - delta.range.start.row);
         this.$tokenUtils.$invalidateRow(delta.range.start.row);
      }
      else if (delta.action === "removeText")
      {
         if (this.$doc.isNewLine(delta.text))
         {
            this.$tokenUtils.$removeRows(delta.range.end.row, 1);
            this.$tokenUtils.$invalidateRow(delta.range.start.row);
         }
         else
         {
            this.$tokenUtils.$invalidateRow(delta.range.start.row);
         }
      }

      this.$scopes.invalidateFrom(delta.range.start);
   };
   
   this.$getIndent = function(line)
   {
      var match = /^([ \t]*)/.exec(line);
      if (!match)
         return ""; // should never happen, but whatever
      else
         return match[1];
   };

   this.$getLine = function(row)
   {
      if (this.$lineOverrides && typeof(this.$lineOverrides[row]) != 'undefined')
         return this.$lineOverrides[row];
      return this.$doc.getLine(row);
   };

}).call(RCodeModel.prototype);

exports.RCodeModel = RCodeModel;

exports.setVerticallyAlignFunctionArgs = function(verticallyAlign) {
   $verticallyAlignFunctionArgs = verticallyAlign;
};

exports.getVerticallyAlignFunctionArgs = function() {
   return $verticallyAlignFunctionArgs;
};


});
