import {test} from 'node:test';
import assert from 'node:assert/strict';
import {bubbleText} from '../src/pixel/bubbleText.js';
import {placeBubble,placeBubbleFallback} from '../src/pixel/annotations.js';
test("B1: bubbles preserve words with two lines and ellipsis",()=>{
 const measure=(s:string)=>s.length;
 for(const text of ['Kaynakları inceliyorum','Kaynakları inceliyorum ve sonuçları karşılaştırıyorum.','Bugünkü raporu hazırlıyorum'])for(const w of [12,16,22]){const lines=bubbleText(text,w,measure).split('\n');assert.ok(lines.length<=2);for(const word of lines.join(' ').replace(/…/g,'').split(' '))assert.ok(text.split(' ').includes(word));}
 assert.equal(bubbleText('Kaynakları inceliyorum ve sonuçları',16,measure),'Kaynakları\ninceliyorum ve…');
});
test("B1: bubbles may cover desks but avoid signs and earlier bubbles",()=>{
 const anchor={x:180,y:100,w:32,h:48},area={x:0,y:0,w:400,h:300},size={w:120,h:36};
 const first=placeBubble(anchor,size,area,[anchor,{x:160,y:55,w:150,h:40}]);assert.ok(first);
 const next=placeBubble(anchor,size,area,[anchor,first!]);assert.ok(next);assert.notDeepEqual(next,first);
});

test("Bubbles sit beside heads without intervening signs or other bubbles",()=>{
 const anchor={x:180,y:100,w:64,h:96},area={x:0,y:0,w:500,h:400},size={w:120,h:42};
 const sign={x:160,y:50,w:150,h:45};
 const first=placeBubble(anchor,size,area,[anchor,sign]);assert.ok(first);
 assert.ok(first.x+first.w<=anchor.x || first.x>=anchor.x+anchor.w);
 const headY=anchor.y+anchor.h*11/48;
 assert.ok(first.y<=headY && first.y+first.h>=headY);
 const second=placeBubble(anchor,size,area,[anchor,sign,first]);assert.ok(second);
 assert.ok(second.x>=anchor.x+anchor.w || second.x+second.w<=anchor.x);
});
test("Bubbles are not moved behind signs at the screen edge",()=>{
 const anchor={x:5,y:100,w:64,h:96},sign={x:0,y:50,w:150,h:45};
 const box=placeBubble(anchor,{w:120,h:42},{x:0,y:0,w:300,h:250},[anchor,sign]);assert.ok(box);
 assert.ok(box.x>=anchor.x+anchor.w);assert.ok(box.y>=sign.y+sign.h);
});

test("Final placement chooses the nearest free position below the head",()=>{
 const anchor={x:80,y:60,w:40,h:60},area={x:0,y:0,w:200,h:200},size={w:60,h:30};
 const sign={x:0,y:0,w:200,h:55},left={x:0,y:55,w:75,h:70},right={x:125,y:55,w:75,h:70};
 const obstacles=[anchor,sign,left,right];
 assert.equal(placeBubble(anchor,size,area,obstacles),undefined);
 const box=placeBubbleFallback(anchor,size,area,obstacles);
 assert.deepEqual(box,{x:70,y:125,...size});
 for(const b of obstacles)assert.ok(box.x+box.w<=b.x || box.x>=b.x+b.w || box.y+box.h<=b.y || box.y>=b.y+b.h);
});

test("Final placement rejects obstacles covering the head with no safe candidate",()=>{
 const area={x:0,y:0,w:100,h:100},anchor={x:30,y:40,w:40,h:60},sign={...area},size={w:60,h:30};
 const box=placeBubbleFallback(anchor,size,area,[anchor,sign]);
 assert.equal(box,undefined);
});

test("Final placement checks intervening signs even without box contact",()=>{
 const area={x:0,y:0,w:200,h:200},anchor={x:80,y:100,w:40,h:60},size={w:60,h:30};
 const sign={x:0,y:50,w:200,h:45},left={x:0,y:95,w:75,h:70},right={x:125,y:95,w:75,h:70},bottom={x:0,y:165,w:200,h:35};
 const obstacles=[anchor,sign,left,right,bottom];
 assert.equal(placeBubble(anchor,size,area,obstacles),undefined);
 assert.equal(placeBubble(anchor,size,area,obstacles,true),undefined);
 assert.equal(placeBubbleFallback(anchor,size,area,obstacles),undefined);
});

test("Final placement avoids earlier bubbles that sever the owner connector",()=>{
 const anchor={x:80,y:100,w:40,h:60},area={x:0,y:0,w:200,h:200},size={w:60,h:30};
 const previousBubble={x:0,y:50,w:200,h:45};
 assert.equal(placeBubbleFallback(anchor,size,area,[anchor,previousBubble,{x:0,y:95,w:75,h:70},{x:125,y:95,w:75,h:70},{x:0,y:165,w:200,h:35}]),undefined);
});

test("Final placement rejects free space outside the viewport",()=>{
 const anchor={x:80,y:100,w:40,h:40},area={x:0,y:0,w:200,h:150},size={w:60,h:30};
 const sign={x:0,y:0,w:200,h:95},left={x:0,y:95,w:75,h:55},right={x:125,y:95,w:75,h:55};
 const obstacles=[anchor,sign,left,right];
 assert.equal(placeBubble(anchor,size,area,obstacles,true),undefined);
 assert.equal(placeBubbleFallback(anchor,size,area,obstacles),undefined);
 // Once the same gap enters the viewport, the box and owner connector are safe.
 const visibleArea={...area,h:200};
 const box=placeBubbleFallback(anchor,size,visibleArea,obstacles)!;
 assert.deepEqual(box,{x:70,y:155,...size});
 assert.ok(box.y+box.h<=visibleArea.y+visibleArea.h);
 assert.ok(box.y>=sign.y+sign.h && box.x<=100 && box.x+box.w>=100);
 assert.ok(left.x+left.w<100 && right.x>100);
 for(const b of obstacles)assert.ok(box.x+box.w<=b.x || box.x>=b.x+b.w || box.y+box.h<=b.y || box.y>=b.y+b.h);
});

test("Narrow bubbles invent no words and preserve long words whole",()=>{
 const source='Kaynakları inceliyorum';
 for(const width of [1,5,8]) {
  const text=bubbleText(source,width,s=>s.length);
  assert.ok(source.split(' ').includes(text.replace(/…/g,'')));
 }
});
