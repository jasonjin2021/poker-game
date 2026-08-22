const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

const rooms = {};


// 创建52张牌
function createDeck() {
    const suits = ["♠", "♥", "♦", "♣"];
    const ranks = [
        "2","3","4","5","6","7",
        "8","9","10","J","Q","K","A"
    ];

    let deck = [];

    for (let s of suits) {
        for (let r of ranks) {
            deck.push(r + s);
        }
    }

    return deck;
}


// 洗牌
function shuffle(deck) {
    for (let i = deck.length - 1; i > 0; i--) {
        let j = Math.floor(Math.random() * (i + 1));

        [deck[i], deck[j]] = [deck[j], deck[i]];
    }

    return deck;
}


// 开始游戏
function startGame(room) {

    room.deck = shuffle(createDeck());

    room.board = [];

    room.players.forEach(p => {
        p.cards = [
            room.deck.pop(),
            room.deck.pop()
        ];

        p.status = "playing";
    });


    // 发三张公共牌 flop
    room.board.push(room.deck.pop());
    room.board.push(room.deck.pop());
    room.board.push(room.deck.pop());


    room.turn = 0;
    room.pot = 0;
}


// AI行动
function botAction(room) {

    room.players.forEach(p => {

        if (p.bot) {

            let r = Math.random();

            if (r < 0.3) {
                p.status = "check";
            }

            else if (r < 0.7) {

                if (p.chips >= 100) {
                    p.chips -= 100;
                    room.pot += 100;
                    p.status = "bet";
                }

            }

            else {

                p.status = "fold";
            }
        }
    });
}



io.on("connection", socket => {


    socket.on("join", ({room,name})=>{


        room = (room || "8888").trim();
        name = (name || "Player").trim();


        socket.join(room);

        socket.data.room = room;


        if(!rooms[room]){

            rooms[room]={
                players:[],
                pot:0,
                board:[]
            };

        }


        let game = rooms[room];


        game.players.push({

            id:socket.id,
            name:name,
            chips:10000,
            status:"waiting",
            bot:false

        });


        // 添加两个机器人
        if(game.players.length===1){

            game.players.push({
                id:"bot1",
                name:"Bot 1",
                chips:10000,
                status:"waiting",
                bot:true
            });


            game.players.push({
                id:"bot2",
                name:"Bot 2",
                chips:10000,
                status:"waiting",
                bot:true
            });

        }



        startGame(game);

        botAction(game);


        io.to(room).emit("state",game);


    });



    socket.on("action",(action)=>{


        let room = rooms[socket.data.room];

        if(!room)return;


        let player =
        room.players.find(
            p=>p.id===socket.id
        );


        if(!player)return;



        if(action==="fold"){

            player.status="fold";

        }


        if(action==="check"){

            player.status="check";

        }



        if(action==="bet"){

            if(player.chips>=100){

                player.chips-=100;

                room.pot+=100;

                player.status="bet";

            }

        }



        io.to(socket.data.room)
        .emit("state",room);


    });



    socket.on("disconnect",()=>{

        let room =
        rooms[socket.data.room];


        if(!room)return;


        room.players =
        room.players.filter(
            p=>p.id!==socket.id
        );


    });


});



server.listen(
    process.env.PORT || 3000,
    ()=>{
        console.log("Poker server running");
    }
);
