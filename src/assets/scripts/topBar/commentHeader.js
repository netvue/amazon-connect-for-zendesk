const headerString = () => `<style>
.comment-box {
    background-color: #fafafa; 
    color: #575757; 
    padding: 0 15px; 
    border: 1px solid #ccc;
    margin-bottom: 5px;
}
.comment-box P {
    padding-bottom: 2px;
}
.comment-section-title {
    font-size: 140%; 
}
.agent-time {
    display: flex;
    justify-content: flex-start;
    font-size: 80%;
    margin-left: 2px;
}
.customer-time {
    display: flex;
    justify-content: flex-end;
    font-size: 80%;
    margin-right: 2px;
}
.turn-bubble {
    border-radius: 5px; 
    margin: 0 4px 15px 4px;
    max-width: 90%; 
    padding: 5px 10px;
}
.agent-turn {
    display: flex;
    justify-content: flex-start;
}
.agent-turn DIV {
    background-color: white;
}
.customer-turn {
    color: #1890ff;
    display: flex;
    justify-content: flex-end;
}
.customer-turn DIV {
    background-color: #e6f7ff;
}
</style>`;

export default headerString;
